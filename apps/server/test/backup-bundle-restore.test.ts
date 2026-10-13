import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { readBundleManifest } from '../src/backup.js';
import type { BackupSystem, BundleJob } from '../src/backup.js';
import { hashPassword } from '@olp/auth';
import type { DbConfig, DbConn, DbDriver, DbEngine } from '../src/database.js';

const KNOWN_PASSWORD = 'bundlepass1';

const fakeEnv: Environment = {
  id: 'debian',
  prettyName: 'Debian 12',
  pkgman: 'apt',
  service: 'systemd',
  isWsl: false,
  libc: 'glibc',
  prefix: '',
  shell: 'sh',
  pathExtra: [],
};

function bundleSys(opts: { failOn?: string; unzipBad?: boolean } = {}): BackupSystem & {
  files: Map<string, string>;
  commands: Array<{ cmd: string; cwd?: string }>;
  zips: Map<string, Map<string, string>>;
} {
  const files = new Map<string, string>();
  const commands: Array<{ cmd: string; cwd?: string }> = [];
  const dirs = new Set<string>();
  // Zip snapshots: archive dest -> staged content (unzip replays it, like real bytes).
  const zips = new Map<string, Map<string, string>>();
  return {
    files,
    commands,
    zips,
    exec: (cmd, _timeoutMs, execOpts = {}) => {
      commands.push({ cmd, cwd: execOpts.cwd });
      if (opts.failOn !== undefined && cmd.includes(opts.failOn)) return Promise.reject(new Error('disk gone'));
      const zip = cmd.match(/^zip -rq '([^']+)' \.$/);
      if (zip !== null && execOpts.cwd !== undefined) {
        const dest = zip[1] ?? '';
        const staged = new Map<string, string>();
        for (const [path, content] of files) {
          if (path.startsWith(`${execOpts.cwd}/`)) staged.set(path.slice(execOpts.cwd.length + 1), content);
        }
        zips.set(dest, staged);
        files.set(dest, `ZIP:${[...staged.keys()].join(',')}`);
        return Promise.resolve('');
      }
      const unzip = cmd.match(/^unzip -o '([^']+)' -d '([^']+)'$/);
      if (unzip !== null) {
        const staging = unzip[2] ?? '';
        for (const [file, content] of zips.get(unzip[1] ?? '') ?? new Map<string, string>()) {
          files.set(join(staging, file), opts.unzipBad === true && file === 'sites.json' ? 'NOT-JSON{{{' : content);
        }
        return Promise.resolve('');
      }
      // Note: `*` (not `+`) so `PGPASSWORD=''` pairs correctly instead of cascading quotes.
      for (const match of cmd.matchAll(/'([^']*)'/g)) {
        const dest = match[1] ?? '';
        if (dest === '') continue;
        if (dest.endsWith('.zip') || dest.endsWith('.sql.gz') || dest.endsWith('.sql')) {
          files.set(dest, `DATA:${cmd.slice(0, 48)}`);
        }
      }
      return Promise.resolve('');
    },
    hasBin: () => Promise.resolve(true),
    mkdirp: (dir) => {
      dirs.add(dir);
    },
    listDir: (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, data, writeOpts = {}) => {
      files.set(path, typeof data === 'string' ? data : data.toString('utf8'));
      void writeOpts;
    },
    removeFile: (path) => {
      files.delete(path);
    },
    statFile: (path) => {
      const content = files.get(path);
      if (content !== undefined) return { size: Buffer.byteLength(content), mtime: 123, isFile: true };
      if (dirs.has(path)) return { size: 0, mtime: 0, isFile: false };
      return null;
    },
    streamFile: (path) => Readable.from([files.get(path) ?? '']),
  };
}

function stubDrivers(lists: Record<DbEngine, string[]>): Record<DbEngine, DbDriver> {
  const stub = (engine: DbEngine): DbDriver => ({
    test: () => Promise.resolve(),
    connect: (cfg: DbConfig) => Promise.resolve({ engine, handle: { cfg } } as DbConn),
    query: () => Promise.resolve({ fields: [], rows: [], affected: null }),
    listDatabases: () => Promise.resolve(lists[engine]),
    listTables: () => Promise.resolve([]),
    previewRows: () => Promise.resolve({ fields: [], rows: [], affected: null }),
    close: () => Promise.resolve(),
    createDatabase: () => Promise.resolve(),
    tableStats: () => Promise.resolve([]),
    tableDef: () => Promise.resolve({ ddl: null, columns: null }),
  });
  return { mysql: stub('mysql'), postgres: stub('postgres') };
}

function stubCron(seed: string[]): {
  backend: {
    readLines: () => Promise<string[]>;
    writeLines: (next: string[]) => Promise<void>;
    exec: () => Promise<string>;
    spawnDetached: () => void;
    hasBin: () => Promise<boolean>;
    runCommand: () => Promise<{ exitCode: number | null; timedOut: boolean; output: string; latencyMs: number }>;
  };
  lines: string[];
  written: string[][];
} {
  const lines = [...seed];
  const written: string[][] = [];
  return {
    lines,
    written,
    backend: {
      readLines: () => Promise.resolve([...lines]),
      writeLines: (next: string[]) => {
        written.push([...next]);
        lines.length = 0;
        lines.push(...next);
        return Promise.resolve();
      },
      exec: () => Promise.resolve(''),
      spawnDetached: () => {},
      hasBin: () => Promise.resolve(true),
      runCommand: () => Promise.resolve({ exitCode: 0, timedOut: false, output: '', latencyMs: 1 }),
    },
  };
}

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'bundle-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-restore-'));
  const dataDir = join(base, 'data');
  const legacyDir = join(base, 'legacy');
  const root = join(base, 'root');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      username: 'tester',
      salt: '0'.repeat(32),
      hash: hashPassword(KNOWN_PASSWORD, '0'.repeat(32)),
    }),
  );
  return { dataDir, legacyDir, root };
}

async function authedCookie(app: FastifyInstance): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'tester', password: KNOWN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const raw = login.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : (raw as string);
  return (first ?? '').split(';')[0] ?? '';
}

async function waitRestore(app: FastifyInstance, cookie: string, id: string): Promise<BundleJob> {
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/bundles/restores/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const job = (res.json() as { job: BundleJob }).job;
    if (job.state === 'done' || job.state === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('restore job never finished');
}

async function waitSnapshot(app: FastifyInstance, cookie: string, id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/bundles/${id}`, headers: { cookie } });
    const job = (res.json() as { job: BundleJob }).job;
    if (job?.state === 'done' || job?.state === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('snapshot never finished');
}

describe('server bundle restore', () => {
  it('gates restores with 401/404', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: bundleSys() });
    expect((await app.inject({ method: 'POST', url: '/api/bundles/nope/restore', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/bundles/restores/nope' })).statusCode).toBe(401);
    const cookie = await authedCookie(app);
    expect((await app.inject({ method: 'POST', url: '/api/bundles/nope/restore', headers: { cookie }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/bundles/../x/restore', headers: { cookie }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/bundles/restores/nope', headers: { cookie } })).statusCode).toBe(404);
  });

  it('replays db reset plus configs and missing-only crons', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys();
    const cron = stubCron(['MAILTO=ops@example.com', '0 2 * * * /bin/sync # panel:ab12:nightly']);
    sys.files.set(join(dataDir, 'sites.json'), JSON.stringify({ sites: [{ id: 'keep' }] }));
    sys.files.set(join(dataDir, 'db.json'), JSON.stringify({}));
    sys.files.set(join(dataDir, 'settings.json'), JSON.stringify({}));
    sys.files.set(join(dataDir, 'nginx.json'), JSON.stringify({ proxies: [] }));
      const { app } = buildServer({
        dataDir,
        legacyDir,
        env: fakeEnv,
        sysDeps: quietDeps(),
        root,
        backupSys: sys,
        dbDrivers: stubDrivers({ mysql: ['appdb'], postgres: [] }),
        cronBackend: cron.backend,
      });
      const cookie = await authedCookie(app);
      const snapId = ((await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} })).json() as { id: string }).id;
      await waitSnapshot(app, cookie, snapId);

      // Drift live state out of band: configs edited, cron job deleted.
      sys.files.set(join(dataDir, 'sites.json'), JSON.stringify({ sites: [{ id: 'drift' }] }));
      cron.lines.length = 0;
      cron.lines.push('MAILTO=ops@example.com');

      const started = await app.inject({ method: 'POST', url: `/api/bundles/${snapId}/restore`, headers: { cookie }, payload: {} });
      expect(started.statusCode).toBe(200);
      const rid = (started.json() as { id: string }).id;
      expect(rid.startsWith('restore-')).toBe(true);
      const job = await waitRestore(app, cookie, rid);
      expect(job.state).toBe('done');
      expect(job.steps.map((s) => s.key)).toEqual([
        `restore-mysql-${snapId}--mysql-appdb`,
        'restore-configs',
        'restore-crons',
      ]);
      expect(job.steps.every((s) => s.status === 'ok')).toBe(true);

      const reset = sys.commands.find((c) => c.cmd.includes('DROP DATABASE'));
      expect(reset?.cmd).toContain('DROP DATABASE IF EXISTS `appdb`; CREATE DATABASE `appdb`');
      const pipe = sys.commands.find((c) => c.cmd.includes('gzip -dc'));
      expect(pipe?.cmd).toContain(`'appdb'`);
      expect(sys.files.get(join(dataDir, 'sites.json'))).toBe(JSON.stringify({ sites: [{ id: 'keep' }] }));
      // Foreign crontab line preserved; exactly one nightly re-created.
      expect(cron.lines.filter((l) => l === 'MAILTO=ops@example.com')).toHaveLength(1);
      expect(cron.lines.filter((l) => l.includes('/bin/sync # panel:'))).toHaveLength(1);
  });

  it('continues after a db failure with failed-if-any', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys({ failOn: 'DROP DATABASE' });
    const cron = stubCron(['0 2 * * * /bin/sync # panel:ab12:nightly']);
    sys.files.set(join(dataDir, 'sites.json'), JSON.stringify({ sites: [] }));
      const { app } = buildServer({
        dataDir,
        legacyDir,
        env: fakeEnv,
        sysDeps: quietDeps(),
        root,
        backupSys: sys,
        dbDrivers: stubDrivers({ mysql: ['appdb'], postgres: [] }),
        cronBackend: cron.backend,
      });
      const cookie = await authedCookie(app);
      const snapId = ((await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} })).json() as { id: string }).id;
      await waitSnapshot(app, cookie, snapId);
      cron.lines.length = 0;
      const rid = ((await app.inject({ method: 'POST', url: `/api/bundles/${snapId}/restore`, headers: { cookie }, payload: {} })).json() as { id: string }).id;
      const job = await waitRestore(app, cookie, rid);
      expect(job.state).toBe('failed');
      expect(job.steps[0]?.status).toBe('failed');
      expect(job.steps.map((s) => s.status)).toEqual(['failed', 'ok', 'ok']);
      // Later steps still ran.
      expect(sys.files.get(join(dataDir, 'sites.json'))).toBe(JSON.stringify({ sites: [] }));
      expect(cron.lines.filter((l) => l.includes('/bin/sync # panel:'))).toHaveLength(1);
  });

  it('blocks corrupt configs with zero live writes', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys({ unzipBad: true });
    const cron = stubCron([]);
    const liveSites = JSON.stringify({ sites: [{ id: 'live' }] });
    sys.files.set(join(dataDir, 'sites.json'), liveSites);
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      backupSys: sys,
      dbDrivers: stubDrivers({ mysql: [], postgres: [] }),
      cronBackend: cron.backend,
    });
    const cookie = await authedCookie(app);
    const snapId = ((await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} })).json() as { id: string }).id;
    await waitSnapshot(app, cookie, snapId);
    const rid = ((await app.inject({ method: 'POST', url: `/api/bundles/${snapId}/restore`, headers: { cookie }, payload: {} })).json() as { id: string }).id;
    const job = await waitRestore(app, cookie, rid);
    expect(job.state).toBe('failed');
    expect(job.steps.find((s) => s.key === 'restore-configs')?.status).toBe('failed');
    expect(job.steps.find((s) => s.key === 'restore-configs')?.detail).toContain('sites.json');
    expect(sys.files.get(join(dataDir, 'sites.json'))).toBe(liveSites);
  });

  it('blocks corrupt cron exports without touching the crontab', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys();
    const cron = stubCron(['0 2 * * * /bin/sync # panel:ab12:nightly']);
    sys.files.set(join(dataDir, 'sites.json'), JSON.stringify({ sites: [] }));
      const { app } = buildServer({
        dataDir,
        legacyDir,
        env: fakeEnv,
        sysDeps: quietDeps(),
        root,
        backupSys: sys,
        dbDrivers: stubDrivers({ mysql: [], postgres: [] }),
        cronBackend: cron.backend,
      });
      const cookie = await authedCookie(app);
      const snapId = ((await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} })).json() as { id: string }).id;
      await waitSnapshot(app, cookie, snapId);
      const manifest = (await app.inject({ method: 'GET', url: `/api/bundles/${snapId}`, headers: { cookie } })).json() as {
        bundle: { parts: Array<{ kind: string; file: string }> };
      };
      const cronsFile = manifest.bundle.parts.find((p) => p.kind === 'crons')?.file ?? '';
      sys.files.set(join(dataDir, 'backups', cronsFile), 'GARBAGE{{{');
      const rid = ((await app.inject({ method: 'POST', url: `/api/bundles/${snapId}/restore`, headers: { cookie }, payload: {} })).json() as { id: string }).id;
      const job = await waitRestore(app, cookie, rid);
      expect(job.state).toBe('failed');
      expect(job.steps.find((s) => s.key === 'restore-crons')?.status).toBe('failed');
      expect(cron.written).toEqual([]);
  });

  it('fails missing part files but still finishes', async () => {    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys();
    const cron = stubCron([]);
    sys.files.set(join(dataDir, 'sites.json'), JSON.stringify({ sites: [] }));
      const { app } = buildServer({
        dataDir,
        legacyDir,
        env: fakeEnv,
        sysDeps: quietDeps(),
        root,
        backupSys: sys,
        dbDrivers: stubDrivers({ mysql: ['appdb'], postgres: [] }),
        cronBackend: cron.backend,
      });
      const cookie = await authedCookie(app);
      const snapId = ((await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} })).json() as { id: string }).id;
      await waitSnapshot(app, cookie, snapId);
      const manifest = (await app.inject({ method: 'GET', url: `/api/bundles/${snapId}`, headers: { cookie } })).json() as {
        bundle: { parts: Array<{ kind: string; file: string }> };
      };
      const dumpFile = manifest.bundle.parts.find((p) => p.kind === 'mysql')?.file ?? '';
      sys.files.delete(join(dataDir, 'backups', dumpFile));
      const rid = ((await app.inject({ method: 'POST', url: `/api/bundles/${snapId}/restore`, headers: { cookie }, payload: {} })).json() as { id: string }).id;
      const job = await waitRestore(app, cookie, rid);
      expect(job.state).toBe('failed');
      expect(job.steps[0]).toMatchObject({ status: 'failed', detail: 'Archive file is missing' });
      expect(job.steps.slice(1).map((s) => s.status)).toEqual(['ok', 'ok']);
      expect(job.steps.some((s) => s.key === 'restore-auth')).toBe(false);
  });
});

describe('server bundle restore-auth', () => {
  const SALT = 's'.repeat(32);
  const authBytes = (pw: string): string =>
    JSON.stringify({ username: 'tester', salt: SALT, hash: hashPassword(pw, SALT), passkeys: [] });

  it('reads pre-038 manifests without hasAuth', async () => {
    const sys = bundleSys();
    sys.files.set(join('/d/backups', 'old.bundle.json'), JSON.stringify({ id: 'old', created: 1, parts: [] }));
    expect(readBundleManifest(sys, '/d', 'old')).toEqual({ id: 'old', created: 1, parts: [] });
    sys.files.set(join('/d/backups', 'bad.bundle.json'), JSON.stringify({ id: 'bad', created: 1, parts: [], hasAuth: 'yes' }));
    expect(readBundleManifest(sys, '/d', 'bad')).toBeNull();
  });

  it('restores credentials last with rollback and logout', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys();
    const cron = stubCron([]);
    const bytesA = authBytes('livepass-aaa111');
    sys.files.set(join(dataDir, 'sites.json'), JSON.stringify({ sites: [] }));
    sys.files.set(join(dataDir, 'config.json'), bytesA);
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      backupSys: sys,
      dbDrivers: stubDrivers({ mysql: [], postgres: [] }),
      cronBackend: cron.backend,
    });
    const cookie = await authedCookie(app);
    const snapId = ((await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} })).json() as { id: string }).id;
    await waitSnapshot(app, cookie, snapId);
    const listed = (await app.inject({ method: 'GET', url: `/api/bundles/${snapId}`, headers: { cookie } })).json() as {
      bundle: { hasAuth?: boolean };
    };
    expect(listed.bundle.hasAuth).toBe(true);

    // Drift live credentials out of band, then restore with the drifted password.
    const bytesB = authBytes('otherpass-bbb222');
    sys.files.set(join(dataDir, 'config.json'), bytesB);
    const started = await app.inject({
      method: 'POST',
      url: `/api/bundles/${snapId}/restore`,
      headers: { cookie },
      payload: { currentPassword: 'otherpass-bbb222' },
    });
    expect(started.statusCode).toBe(200);
    const rid = (started.json() as { id: string }).id;
    // Poll until the expected logout (revoke kills the session at the end).
    let job: BundleJob | null = null;
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/bundles/restores/${rid}`, headers: { cookie } });
      if (res.statusCode === 401) break;
      const state = (res.json() as { job: BundleJob }).job;
      if (state.state === 'done' || state.state === 'failed') {
        job = state;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The operator session is dead either way (revoke ran before finish).
    expect((await app.inject({ method: 'GET', url: '/api/backups', headers: { cookie } })).statusCode).toBe(401);
    expect(sys.files.get(join(dataDir, 'config.json'))).toBe(bytesA);
    const rollbacks = [...sys.files.keys()].filter((k) => k.includes('config.json.pre-restore-'));
    expect(rollbacks).toHaveLength(1);
    expect(sys.files.get(rollbacks[0] as string)).toBe(bytesB);
    if (job !== null) {
      expect(job.state).toBe('done');
      expect(job.steps.at(-1)).toMatchObject({ key: 'restore-auth', status: 'ok' });
    }
  });

  it('fails closed on wrong or missing passwords with zero writes', async () => {
    for (const payload of [{ currentPassword: 'wrong-pw' }, {}]) {
      const { dataDir, legacyDir, root } = freshWorkspace();
      const sys = bundleSys();
      const cron = stubCron([]);
      const bytesA = authBytes('livepass-aaa111');
      sys.files.set(join(dataDir, 'sites.json'), JSON.stringify({ sites: [] }));
      sys.files.set(join(dataDir, 'config.json'), bytesA);
      const { app } = buildServer({
        dataDir,
        legacyDir,
        env: fakeEnv,
        sysDeps: quietDeps(),
        root,
        backupSys: sys,
        dbDrivers: stubDrivers({ mysql: [], postgres: [] }),
        cronBackend: cron.backend,
      });
      const cookie = await authedCookie(app);
      const snapId = ((await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} })).json() as { id: string }).id;
      await waitSnapshot(app, cookie, snapId);
      const rid = (
        (await app.inject({ method: 'POST', url: `/api/bundles/${snapId}/restore`, headers: { cookie }, payload })).json() as { id: string }
      ).id;
      const job = await waitRestore(app, cookie, rid);
      expect(job.state).toBe('failed');
      expect(job.steps.find((s) => s.key === 'restore-auth')?.detail).toMatch(/Current password/);
      expect(sys.files.get(join(dataDir, 'config.json'))).toBe(bytesA);
      expect([...sys.files.keys()].some((k) => k.includes('pre-restore'))).toBe(false);
      expect((await app.inject({ method: 'GET', url: '/api/backups', headers: { cookie } })).statusCode).toBe(200);
    }
  });

  it('blocks corrupt bundled auth without touching live bytes', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys();
    const cron = stubCron([]);
    const bytesA = authBytes('livepass-aaa111');
    sys.files.set(join(dataDir, 'sites.json'), JSON.stringify({ sites: [] }));
    sys.files.set(join(dataDir, 'config.json'), bytesA);
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      backupSys: sys,
      dbDrivers: stubDrivers({ mysql: [], postgres: [] }),
      cronBackend: cron.backend,
    });
    const cookie = await authedCookie(app);
    const snapId = ((await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} })).json() as { id: string }).id;
    await waitSnapshot(app, cookie, snapId);
    for (const staged of sys.zips.values()) {
      if (staged.has('auth.json')) staged.set('auth.json', 'GARBAGE{{{');
    }
    const rid = (
      (await app.inject({ method: 'POST', url: `/api/bundles/${snapId}/restore`, headers: { cookie }, payload: { currentPassword: 'livepass-aaa111' } }))
        .json() as { id: string }
    ).id;
    const job = await waitRestore(app, cookie, rid);
    expect(job.state).toBe('failed');
    expect(job.steps.find((s) => s.key === 'restore-auth')).toMatchObject({ status: 'failed', detail: 'Invalid auth in bundle' });
    expect(sys.files.get(join(dataDir, 'config.json'))).toBe(bytesA);
    expect((await app.inject({ method: 'GET', url: '/api/backups', headers: { cookie } })).statusCode).toBe(200);
  });
});
