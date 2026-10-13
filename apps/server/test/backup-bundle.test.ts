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
import { createBundleJob, parseBundleSelection, runBundleSnapshot } from '../src/backup.js';
import type { BackupSystem, BundleJob } from '../src/backup.js';
import type { CronJob } from '../src/cron.js';
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

interface ExecGate {
  predicate: (cmd: string) => boolean;
  promise: Promise<string>;
}

/** Memory sys whose exec materializes quoted archive dests (deterministic bytes for hash/verify). */
function bundleSys(opts: { failOn?: string; gate?: ExecGate } = {}): BackupSystem & {
  files: Map<string, string>;
  modes: Map<string, number | undefined>;
  commands: Array<{ cmd: string; cwd?: string }>;
} {
  const files = new Map<string, string>();
  const modes = new Map<string, number | undefined>();
  const commands: Array<{ cmd: string; cwd?: string }> = [];
  const dirs = new Set<string>();
  return {
    files,
    modes,
    commands,
    exec: (cmd, _timeoutMs, execOpts = {}) => {
      commands.push({ cmd, cwd: execOpts.cwd });
      if (opts.gate !== undefined && opts.gate.predicate(cmd)) return opts.gate.promise;
      if (opts.failOn !== undefined && cmd.includes(opts.failOn)) return Promise.reject(new Error('disk gone'));
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
      modes.set(path, writeOpts.mode);
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

function stubDrivers(lists: Record<DbEngine, string[]>, connectError?: string): Record<DbEngine, DbDriver> {
  const stub = (engine: DbEngine): DbDriver => ({
    test: () => Promise.resolve(),
    connect: (cfg: DbConfig) => {
      if (connectError !== undefined) return Promise.reject(new Error(connectError));
      const conn: DbConn = { engine, handle: { cfg } };
      return Promise.resolve(conn);
    },
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

function stubCron(lines: string[]): {
  backend: {
    readLines: () => Promise<string[]>;
    writeLines: (next: string[]) => Promise<void>;
    exec: () => Promise<string>;
    spawnDetached: () => void;
    hasBin: () => Promise<boolean>;
    runCommand: () => Promise<{ exitCode: number | null; timedOut: boolean; output: string; latencyMs: number }>;
  };
} {
  return {
    backend: {
      readLines: () => Promise.resolve([...lines]),
      writeLines: () => Promise.resolve(),
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
  const base = mkdtempSync(join(tmpdir(), 'olp-bundle-'));
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

function seedConfigs(sys: { files: Map<string, string> }, dataDir: string): void {
  sys.files.set(join(dataDir, 'sites.json'), JSON.stringify({ sites: [] }));
  sys.files.set(join(dataDir, 'db.json'), JSON.stringify({}));
  sys.files.set(join(dataDir, 'settings.json'), JSON.stringify({}));
  sys.files.set(join(dataDir, 'nginx.json'), JSON.stringify({ proxies: [] }));
}

async function waitJob(app: FastifyInstance, cookie: string, id: string): Promise<{ bundle: unknown; job: BundleJob }> {
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/bundles/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { bundle: unknown; job: BundleJob };
    if (body.job?.state === 'done' || body.job?.state === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('bundle job never finished');
}

describe('bundle selection', () => {
  it('parses defaults and rejects bad shapes', () => {
    expect(parseBundleSelection({})).toEqual({});
    expect(parseBundleSelection({ databases: { mysql: ['a'] }, configs: false, crons: true })).toEqual({
      databases: { mysql: ['a'] },
      configs: false,
      crons: true,
    });
    for (const bad of [{ databases: 'x' }, { databases: ['a'] }, { databases: { mysql: [1] } }, { configs: 'yes' }, { crons: 1 }]) {
      expect(() => parseBundleSelection(bad as Record<string, unknown>)).toThrow();
    }
  });
});

describe('server bundle snapshot', () => {
  it('gates with 401 and 404s unknown bundles', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: bundleSys() });
    expect((await app.inject({ method: 'POST', url: '/api/bundles', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/bundles' })).statusCode).toBe(401);
    const cookie = await authedCookie(app);
    expect((await app.inject({ method: 'GET', url: '/api/bundles/nope', headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/bundles/../x', headers: { cookie } })).statusCode).toBe(404);
  });

  it('snapshots all discovered DBs plus configs and crons', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys();
    seedConfigs(sys, dataDir);
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      backupSys: sys,
      dbDrivers: stubDrivers({ mysql: ['information_schema', 'mysql', 'performance_schema', 'sys', 'appdb', 'blog'], postgres: ['postgres', 'template0', 'template1', 'pgdb'] }),
      cronBackend: stubCron(['0 2 * * * /bin/sync # panel:ab12:nightly']).backend,
    });
    const cookie = await authedCookie(app);
    const started = await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} });
    expect(started.statusCode).toBe(200);
    const id = (started.json() as { id: string }).id;
    expect(id.startsWith('bundle-')).toBe(true);

    const { bundle, job } = await waitJob(app, cookie, id);
    expect(job.state).toBe('done');
    expect(job.steps.map((s) => s.key)).toEqual([
      'enumerate',
      'dump-mysql-appdb',
      'dump-mysql-blog',
      'dump-postgres-pgdb',
      'configs',
      'crons',
      'manifest',
    ]);
    expect(job.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(job.steps[0]?.detail).toBe('mysql: 2, postgres: 1');

    const manifest = bundle as { id: string; parts: Array<{ name: string; file: string; kind: string; sha256: string }> };
    expect(manifest.id).toBe(id);
    expect(manifest.parts).toHaveLength(5);
    expect(manifest.parts.map((p) => p.kind)).toEqual(['mysql', 'mysql', 'postgres', 'configs', 'crons']);
    for (const part of manifest.parts) {
      expect(part.sha256).toHaveLength(64);
      const verify = await app.inject({ method: 'GET', url: `/api/backups/${part.name}/verify`, headers: { cookie } });
      expect(verify.json()).toMatchObject({ ok: true, match: true });
    }
    const listed = await app.inject({ method: 'GET', url: '/api/bundles', headers: { cookie } });
    expect((listed.json() as { bundles: Array<{ id: string }> }).bundles.map((b) => b.id)).toEqual([id]);
    // Staging cleaned: no staged copies remain in memory.
    expect([...sys.files.keys()].every((k) => !k.includes('.staging-'))).toBe(true);
    // Manifest persisted 0600.
    expect(sys.modes.get(join(dataDir, 'backups', `${id}.bundle.json`))).toBe(0o600);
  });

  it('respects the requested selection', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys();
    seedConfigs(sys, dataDir);
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      backupSys: sys,
      dbDrivers: stubDrivers({ mysql: ['appdb', 'blog'], postgres: ['pgdb'] }),
      cronBackend: stubCron([]).backend,
    });
    const cookie = await authedCookie(app);
    const started = await app.inject({
      method: 'POST',
      url: '/api/bundles',
      headers: { cookie },
      payload: { databases: { mysql: ['blog'], postgres: [] }, configs: false, crons: false },
    });
    expect(started.statusCode).toBe(200);
    const id = (started.json() as { id: string }).id;
    const { bundle, job } = await waitJob(app, cookie, id);
    expect(job.state).toBe('done');
    expect(job.steps.map((s) => s.key)).toEqual(['enumerate', 'dump-mysql-blog', 'manifest']);
    expect((bundle as { parts: unknown[] }).parts).toHaveLength(1);
  });

  it('marks mid-run failure with earlier parts intact and no manifest', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys({ failOn: `'blog'` });
    seedConfigs(sys, dataDir);
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      backupSys: sys,
      dbDrivers: stubDrivers({ mysql: ['appdb', 'blog'], postgres: [] }),
      cronBackend: stubCron([]).backend,
    });
    const cookie = await authedCookie(app);
    const started = await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: { databases: { mysql: ['appdb', 'blog'] }, configs: false, crons: false } });
    const id = (started.json() as { id: string }).id;
    const { bundle, job } = await waitJob(app, cookie, id);
    expect(job.state).toBe('failed');
    expect(job.finished).not.toBeNull();
    const failed = job.steps.find((s) => s.key === 'dump-mysql-blog');
    expect(failed?.status).toBe('failed');
    expect(job.steps.find((s) => s.key === 'dump-mysql-appdb')?.status).toBe('ok');
    expect(bundle).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/bundles', headers: { cookie } })).json()).toEqual({ bundles: [] });
    // Earlier part stays a normal visible archive.
    const list = (await app.inject({ method: 'GET', url: '/api/backups', headers: { cookie } })).json() as { backups: Array<{ name: string }> };
    expect(list.backups.some((b) => b.name.includes('--mysql-appdb'))).toBe(true);
    expect([...sys.files.keys()].every((k) => !k.includes('.staging-'))).toBe(true);
  });

  it('rejects a double start while one snapshot runs', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    let release: ((value: string) => void) | null = null;
    const gate: ExecGate = { predicate: (cmd) => cmd.includes('mysqldump'), promise: new Promise<string>((resolve) => { release = resolve; }) };
    const sys = bundleSys({ gate });
    seedConfigs(sys, dataDir);
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      backupSys: sys,
      dbDrivers: stubDrivers({ mysql: ['appdb'], postgres: [] }),
      cronBackend: stubCron([]).backend,
    });
    const cookie = await authedCookie(app);
    const first = await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} });
    expect(first.statusCode).toBe(200);
    const id = (first.json() as { id: string }).id;
    const second = await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'A bundle snapshot is already running' });
    release?.('');
    const { job } = await waitJob(app, cookie, id);
    expect(job.state).toBe('done');
  });

  it('snapshots configs and crons on engine-less boxes', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys();
    seedConfigs(sys, dataDir);
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      backupSys: sys,
      dbDrivers: stubDrivers({ mysql: [], postgres: [] }, 'ECONNREFUSED'),
      cronBackend: stubCron([]).backend,
    });
    const cookie = await authedCookie(app);
    const started = await app.inject({ method: 'POST', url: '/api/bundles', headers: { cookie }, payload: {} });
    const id = (started.json() as { id: string }).id;
    const { bundle, job } = await waitJob(app, cookie, id);
    expect(job.state).toBe('done');
    expect(job.steps.map((s) => s.key)).toEqual(['enumerate', 'configs', 'crons', 'manifest']);
    expect((bundle as { parts: Array<{ kind: string }> }).parts.map((p) => p.kind)).toEqual(['configs', 'crons']);
  });

  it('records discovery throw as an honest empty enumerate (direct run)', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = bundleSys();
    seedConfigs(sys, dataDir);
    const cronJobs: CronJob[] = [{ id: 'ab12', name: 'nightly', schedule: '0 2 * * *', command: '/bin/sync', enabled: true }];
    const job = createBundleJob('bundle-direct', 1000);
    const done = await runBundleSnapshot(
      {
        sys,
        dataDir,
        root,
        dbConfig: () => ({ host: 'h', port: 3306, user: 'u', password: '', database: '' }),
        now: () => 2000,
        discovery: {
          listDatabases: () => Promise.reject(new Error('boom')),
          readCronJobs: () => Promise.resolve(cronJobs),
          readCronLines: () => Promise.resolve([]),
          writeCronLines: () => Promise.resolve(),
          revokeSessions: () => {},
        },
      },
      job,
      {},
    );
    expect(done.state).toBe('done');
    expect(done.steps[0]).toMatchObject({ key: 'enumerate', status: 'ok' });
    expect(done.steps[0]?.detail).toContain('list failed');
    expect(done.steps.map((s) => s.key)).toEqual(['enumerate', 'configs', 'crons', 'manifest']);
  });
});
