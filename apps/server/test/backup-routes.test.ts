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
import { hashStream } from '../src/backup.js';
import { sanitizeBackupName } from '../src/backup.js';
import type { BackupSystem } from '../src/backup.js';
import type { DbConfig } from '../src/database.js';

const KNOWN_PASSWORD = 'backuppass1';

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

function dbConfig(password: string): (engine: 'mysql' | 'postgres') => DbConfig {
  return (engine) => ({
    host: 'h',
    port: engine === 'mysql' ? 3306 : 5432,
    user: 'u',
    password,
    database: '',
  });
}

function memorySys(bins: Record<string, boolean> = {}, execError?: string): BackupSystem & {
  files: Map<string, string>;
  modes: Map<string, number | undefined>;
  commands: Array<{ cmd: string; cwd?: string }>;
  mkdirs: string[];
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const modes = new Map<string, number | undefined>();
  const commands: Array<{ cmd: string; cwd?: string }> = [];
  const mkdirs: string[] = [];
  const dirs = new Set<string>();
  return {
    files,
    modes,
    commands,
    mkdirs,
    dirs,
    exec: (cmd, _timeoutMs, opts = {}) => {
      commands.push({ cmd, cwd: opts.cwd });
      return execError !== undefined ? Promise.reject(new Error(execError)) : Promise.resolve('');
    },
    hasBin: (bin) => Promise.resolve(bins[bin] ?? true),
    mkdirp: (dir) => {
      mkdirs.push(dir);
      dirs.add(dir);
    },
    listDir: (dir) =>
      [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, data, opts = {}) => {
      files.set(path, data);
      modes.set(path, opts.mode);
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

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'backup-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-backup-'));
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

function backupsOf(sys: { files: Map<string, string> }, dataDir: string): string {
  return join(dataDir, 'backups');
}

describe('backup names', () => {
  it('sanitizes with stamp fallback', () => {
    expect(sanitizeBackupName('  ok-name_1.json ', () => 'fb')).toBe('ok-name_1.json');
    expect(sanitizeBackupName('../x', () => 'fb')).toBe('.._x');
    expect(sanitizeBackupName('   ', () => 'backup-20240102-030405')).toBe('backup-20240102-030405');
    expect(() => sanitizeBackupName('   ', () => '')).toThrow(/Invalid name/);
  });
});

describe('server backup routes', () => {
  it('gates with 401', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    expect((await app.inject({ method: 'GET', url: '/api/backups' })).statusCode).toBe(401);
  });

  it('creates folder zips with exact command and 0600 sidecar', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    sys.dirs.add(join(root, 'proj'));
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    const cookie = await authedCookie(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups',
      headers: { cookie },
      payload: { type: 'folder', name: 'b1', source: 'proj' },
    });
    expect(res.json()).toEqual({ ok: true, name: 'b1' });
    expect(sys.commands).toEqual([{ cmd: `zip -rq '${backupsOf(sys, dataDir)}/b1.zip' .`, cwd: join(root, 'proj') }]);
    expect(JSON.parse(sys.files.get(join(backupsOf(sys, dataDir), 'b1.json')) ?? '')).toMatchObject({
      name: 'b1',
      file: 'b1.zip',
      type: 'folder',
      source: 'proj',
    });
    expect(sys.modes.get(join(backupsOf(sys, dataDir), 'b1.json'))).toBe(0o600);

    const list = await app.inject({ method: 'GET', url: '/api/backups', headers: { cookie } });
    expect(list.json().backups).toHaveLength(0); // archive itself was never materialized by the fake

    sys.files.set(join(backupsOf(sys, dataDir), 'b1.zip'), 'ZIPDATA');
    const list2 = await app.inject({ method: 'GET', url: '/api/backups', headers: { cookie } });
    expect(list2.json().backups).toMatchObject([{ name: 'b1', file: 'b1.zip', size: 7 }]);
  });

  it('validates creation', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys({ zip: false });
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    const cookie = await authedCookie(app);
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/backups', headers: { cookie }, payload });

    expect((await post({ type: 'dvd', name: 'x' })).json().error).toBe('Invalid type');
    expect((await post({ type: 'mysql', name: 'x', source: '' })).json().error).toBe('Database name is required');
    expect((await post({ type: 'folder', name: 'x', source: 'missing' })).json().error).toBe('Source not found');
    sys.dirs.add(join(root, 'proj'));
    expect((await post({ type: 'folder', name: 'x', source: 'proj' })).json().error).toMatch(/Package "zip" is not installed/);

    const okSys = memorySys();
    okSys.dirs.add(join(root, 'proj'));
    const w2 = freshWorkspace();
    const { app: app2 } = buildServer({
      dataDir: w2.dataDir,
      legacyDir: w2.legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root: w2.root,
      backupSys: okSys,
      backupDbConfig: dbConfig('pw'),
    });
    const cookie2 = await authedCookie(app2);
    okSys.dirs.add(join(w2.root, 'proj'));
    expect(
      (await app2.inject({ method: 'POST', url: '/api/backups', headers: { cookie: cookie2 }, payload: { type: 'folder', name: 'dup', source: 'proj' } })).statusCode,
    ).toBe(200);
    expect(
      (await app2.inject({ method: 'POST', url: '/api/backups', headers: { cookie: cookie2 }, payload: { type: 'folder', name: 'dup', source: 'proj' } })).json().error,
    ).toBe('Backup name already taken');
  });

  it('dumps mysql and postgres with exact pipelines', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('s3cret') });
    const cookie = await authedCookie(app);
    const dir = backupsOf(sys, dataDir);

    expect(
      (await app.inject({ method: 'POST', url: '/api/backups', headers: { cookie }, payload: { type: 'mysql', name: 'm1', source: 'appdb' } })).json(),
    ).toEqual({ ok: true, name: 'm1' });
    expect(sys.commands[0]?.cmd).toBe(
      `mysqldump -h 'h' -P '3306' -u 'u' --password='s3cret' 'appdb' > '${dir}/m1.sql'`,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/backups', headers: { cookie }, payload: { type: 'postgres', name: 'p1', source: 'appdb' } })).json(),
    ).toEqual({ ok: true, name: 'p1' });
    expect(sys.commands[1]?.cmd).toBe(
      `PGPASSWORD='s3cret' pg_dump -h 'h' -p '5432' -U 'u' -d 'appdb' > '${dir}/p1.sql'`,
    );

    const w2 = freshWorkspace();
    const sys2 = memorySys();
    const { app: app2 } = buildServer({
      dataDir: w2.dataDir,
      legacyDir: w2.legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root: w2.root,
      backupSys: sys2,
      backupDbConfig: dbConfig(''),
    });
    const cookie2 = await authedCookie(app2);
    await app2.inject({ method: 'POST', url: '/api/backups', headers: { cookie: cookie2 }, payload: { type: 'mysql', name: 'm2', source: 'appdb' } });
    expect(sys2.commands[0]?.cmd).toBe(`mysqldump -h 'h' -P '3306' -u 'u' 'appdb' > '${backupsOf(sys2, w2.dataDir)}/m2.sql'`);
  });

  it('gzips dumps on request and restores through gunzip', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    const cookie = await authedCookie(app);
    const dir = backupsOf(sys, dataDir);
    const created = await app.inject({
      method: 'POST',
      url: '/api/backups',
      headers: { cookie },
      payload: { type: 'mysql', name: 'g1', source: 'appdb', gzip: true },
    });
    expect(created.json()).toEqual({ ok: true, name: 'g1' });
    expect(sys.commands[0]?.cmd).toContain(`mysqldump -h 'h' -P '3306' -u 'u' --password='pw' 'appdb' | gzip > '${dir}/g1.sql.gz'`);
    sys.files.set(join(dir, 'g1.sql.gz'), 'GZD');
    const restored = await app.inject({ method: 'POST', url: '/api/backups/g1/restore', headers: { cookie }, payload: {} });
    expect(restored.json()).toEqual({ ok: true });
    expect(sys.commands.at(-1)?.cmd).toContain(`gzip -dc '${dir}/g1.sql.gz' | mysql `);
  });

  it('downloads, deletes, and guards names', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    sys.dirs.add(join(root, 'proj'));
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    const cookie = await authedCookie(app);
    await app.inject({ method: 'POST', url: '/api/backups', headers: { cookie }, payload: { type: 'folder', name: 'b1', source: 'proj' } });
    const dir = backupsOf(sys, dataDir);
    sys.files.set(join(dir, 'b1.zip'), 'ZIPDATA');

    const down = await app.inject({ method: 'GET', url: '/api/backups/b1/download', headers: { cookie } });
    expect(down.statusCode).toBe(200);
    expect(down.headers['content-type']).toBe('application/octet-stream');
    expect(down.headers['content-disposition']).toBe('attachment; filename="b1.zip"');
    expect(down.body).toBe('ZIPDATA');

    expect((await app.inject({ method: 'GET', url: '/api/backups/nope/download', headers: { cookie } })).json().error).toBe('Backup not found');
    expect((await app.inject({ method: 'GET', url: '/api/backups/a%20b/download', headers: { cookie } })).json().error).toBe('Backup not found');

    expect((await app.inject({ method: 'DELETE', url: '/api/backups/b1', headers: { cookie } })).json()).toEqual({ ok: true });
    expect(sys.files.has(join(dir, 'b1.zip'))).toBe(false);
    expect(sys.files.has(join(dir, 'b1.json'))).toBe(false);
    // deleting twice still resolves (archive already gone is tolerated, meta gone → 400)
    expect((await app.inject({ method: 'DELETE', url: '/api/backups/b1', headers: { cookie } })).json().error).toBe('Backup not found');
  });

  it('restores folders and databases with exact commands', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    sys.dirs.add(join(root, 'proj'));
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    const cookie = await authedCookie(app);
    await app.inject({ method: 'POST', url: '/api/backups', headers: { cookie }, payload: { type: 'folder', name: 'b1', source: 'proj' } });
    const dir = backupsOf(sys, dataDir);
    sys.files.set(join(dir, 'b1.zip'), 'ZIPDATA');

    const target = join(root, 'restored');
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/b1/restore',
      headers: { cookie },
      payload: { targetPath: 'restored' },
    });
    expect(res.json()).toEqual({ ok: true });
    expect(sys.mkdirs).toContain(target);
    expect(sys.commands.at(-1)?.cmd).toBe(`unzip -o '${dir}/b1.zip' -d '${target}'`);

    const def = await app.inject({ method: 'POST', url: '/api/backups/b1/restore', headers: { cookie }, payload: {} });
    expect(def.json()).toEqual({ ok: true });
    expect(sys.commands.at(-1)?.cmd).toBe(`unzip -o '${dir}/b1.zip' -d '${join(root, 'proj')}'`);

    const evil = await app.inject({
      method: 'POST',
      url: '/api/backups/b1/restore',
      headers: { cookie },
      payload: { targetPath: '..' },
    });
    expect(evil.statusCode).toBe(400);

    await app.inject({ method: 'POST', url: '/api/backups', headers: { cookie }, payload: { type: 'mysql', name: 'm1', source: 'appdb' } });
    sys.files.set(join(dir, 'm1.sql'), 'DUMP');
    await app.inject({ method: 'POST', url: '/api/backups/m1/restore', headers: { cookie }, payload: {} });
    expect(sys.commands.at(-1)?.cmd).toBe(
      `mysql -h 'h' -P '3306' -u 'u' --password='pw' 'appdb' < '${dir}/m1.sql'`,
    );
    await app.inject({ method: 'POST', url: '/api/backups', headers: { cookie }, payload: { type: 'postgres', name: 'p1', source: 'appdb' } });
    sys.files.set(join(dir, 'p1.sql'), 'DUMP');
    await app.inject({ method: 'POST', url: '/api/backups/p1/restore', headers: { cookie }, payload: {} });
    expect(sys.commands.at(-1)?.cmd).toBe(
      `PGPASSWORD='pw' psql -h 'h' -p '5432' -U 'u' -d 'appdb' < '${dir}/p1.sql'`,
    );
  });

  it('lists newest-first skipping corrupt and orphan entries', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    const dir = join(dataDir, 'backups');
    sys.files.set(join(dir, 'old.json'), JSON.stringify({ name: 'old', file: 'old.zip', type: 'folder', source: 'a', created: 1000 }));
    sys.files.set(join(dir, 'old.zip'), 'x');
    sys.files.set(join(dir, 'new.json'), JSON.stringify({ name: 'new', file: 'new.zip', type: 'folder', source: 'b', created: 2000 }));
    sys.files.set(join(dir, 'new.zip'), 'yy');
    sys.files.set(join(dir, 'broken.json'), 'not json{{{');
    sys.files.set(join(dir, 'orphan.json'), JSON.stringify({ name: 'orphan', file: 'gone.zip', type: 'folder', source: 'c', created: 3000 }));
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    const cookie = await authedCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/backups', headers: { cookie } });
    expect(res.json().backups.map((b: { name: string }) => b.name)).toEqual(['new', 'old']);
    expect(res.json().backups[0]).toMatchObject({ file: 'new.zip', size: 2 });
  });

  it('hashes streams to known vectors', async () => {
    expect(await hashStream(Readable.from(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hashStream(Readable.from([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('stores hashes at create and verifies them', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    sys.dirs.add(join(root, 'proj'));
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    const cookie = await authedCookie(app);
    // Fake exec never materializes the archive: pre-seed it so the stored hash covers real bytes.
    sys.files.set(join(backupsOf(sys, dataDir), 'h1.zip'), 'ZIPDATA');
    await app.inject({ method: 'POST', url: '/api/backups', headers: { cookie }, payload: { type: 'folder', name: 'h1', source: 'proj' } });
    const sidecar = JSON.parse(sys.files.get(join(backupsOf(sys, dataDir), 'h1.json')) ?? '');
    expect(typeof sidecar.sha256).toBe('string');
    expect(sidecar.sha256).toHaveLength(64);
    const verify = await app.inject({ method: 'GET', url: '/api/backups/h1/verify', headers: { cookie } });
    expect(verify.json()).toEqual({ ok: true, sha256: sidecar.sha256, match: true });
    expect((await app.inject({ method: 'GET', url: '/api/backups/nope/verify', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/backups/h1/verify' })).statusCode).toBe(401);
  });

  it('verifies pre-hash sidecars as unknown', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    const cookie = await authedCookie(app);
    sys.files.set(join(backupsOf(sys, dataDir), 'old.json'), JSON.stringify({ name: 'old', file: 'old.zip', type: 'folder', source: 'b', created: 1 }));
    sys.files.set(join(backupsOf(sys, dataDir), 'old.zip'), 'x');
    const verify = await app.inject({ method: 'GET', url: '/api/backups/old/verify', headers: { cookie } });
    expect(verify.json()).toMatchObject({ ok: true, match: null });
    expect(typeof verify.json().sha256).toBe('string');
  });

  it('imports uploads with validation and round-trips restore', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    const cookie = await authedCookie(app);
    const upload = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/api/backups/upload', headers: { cookie }, payload });
    expect((await upload({ type: 'dvd', data: 'eA==' })).json().error).toBe('Invalid type');
    expect((await upload({ type: 'folder' })).json().error).toBe('Archive data is required');
    const data = Buffer.from('UPLOADDATA').toString('base64');
    const ok = await upload({ type: 'folder', name: 'up1', data });
    expect(ok.json()).toEqual({ ok: true, name: 'up1' });
    expect((await upload({ type: 'folder', name: 'up1', data })).json().error).toBe('Backup name already taken');
    const list = await app.inject({ method: 'GET', url: '/api/backups', headers: { cookie } });
    expect(list.json().backups).toMatchObject([{ name: 'up1', file: 'up1.zip', source: 'upload' }]);
    const verify = await app.inject({ method: 'GET', url: '/api/backups/up1/verify', headers: { cookie } });
    expect(verify.json()).toMatchObject({ ok: true, match: true });
    sys.dirs.add(join(root, 'restored'));
    const restored = await app.inject({ method: 'POST', url: '/api/backups/up1/restore', headers: { cookie }, payload: { targetPath: 'restored' } });
    expect(restored.json()).toEqual({ ok: true });
    const data2 = Buffer.from('UPLOADDATA').toString('base64');
    expect((await app.inject({ method: 'POST', url: '/api/backups/upload', payload: { type: 'folder', name: 'up2', data: data2 } })).statusCode).toBe(401);
  });

  it('manages schedules with validation and toggle', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const sys = memorySys();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, backupSys: sys, backupDbConfig: dbConfig('pw') });
    const cookie = await authedCookie(app);
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/backups/schedules', headers: { cookie }, payload });
    expect((await post({ type: 'dvd', schedule: '* * * * *', source: 'x' })).json().error).toBe('Invalid type');
    expect((await post({ type: 'folder', schedule: 'nonsense', source: 'x' })).json().error).toBe('Invalid schedule (5 cron fields required)');
    expect((await post({ type: 'folder', schedule: '* * * * *', source: '' })).json().error).toBe('Source is required');
    const created = await post({ type: 'folder', name: 'night', schedule: '* * * * *', source: 'proj' });
    expect(created.json().ok).toBe(true);
    const sid = (created.json().schedule as { id: string }).id;
    const list = await app.inject({ method: 'GET', url: '/api/backups/schedules', headers: { cookie } });
    expect(list.json().schedules).toMatchObject([{ name: 'night', enabled: true, lastRun: null }]);
    expect(typeof list.json().schedules[0].nextRun).toBe('number');
    const toggled = await app.inject({ method: 'POST', url: `/api/backups/schedules/${sid}/toggle`, headers: { cookie } });
    expect(toggled.json()).toEqual({ ok: true });
    const unknown = await app.inject({ method: 'POST', url: '/api/backups/schedules/zz/toggle', headers: { cookie } });
    expect(unknown.statusCode).toBe(404);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/backups/schedules/${sid}`, headers: { cookie } });
    expect(deleted.json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: '/api/backups/schedules' })).statusCode).toBe(401);
  });

  it('ticks due schedules and records failures', async () => {
    const { dueSchedules, readSchedules, runDueBackups } = await import('../src/backup.js');
    const { dataDir, root } = freshWorkspace();
    const sys = memorySys();
    sys.dirs.add(join(root, 'proj'));
    const deps = { sys, dataDir, root, dbConfig: dbConfig('pw'), now: () => 1728470400000 };
    expect(dueSchedules([], 1728470400000)).toEqual([]);
    expect(
      dueSchedules(
        [{ id: 'a', name: 'n', type: 'folder', source: 'proj', schedule: '* * * * *', enabled: false, created: 0, lastRun: null, lastStatus: null }],
        1728470400000,
      ),
    ).toEqual([]);
    sys.writeFile(
      join(backupsOf(sys, dataDir), 'backup-schedules.json'),
      JSON.stringify([
        { id: 's1', name: 'night', type: 'folder', source: 'proj', schedule: '* * * * *', enabled: true, created: 0, lastRun: null, lastStatus: null },
      ]),
      { mode: 0o600 },
    );
    await runDueBackups(deps, 1728470400000);
    const after = readSchedules(sys, dataDir);
    expect(after).toMatchObject([{ id: 's1', lastRun: 1728470400000, lastStatus: 'ok' }]);
    const w2 = freshWorkspace();
    const missing = memorySys({ zip: false });
    missing.dirs.add(join(w2.root, 'proj'));
    missing.writeFile(
      join(backupsOf(missing, w2.dataDir), 'backup-schedules.json'),
      JSON.stringify([
        { id: 's1', name: 'night', type: 'folder', source: 'proj', schedule: '* * * * *', enabled: true, created: 0, lastRun: null, lastStatus: null },
      ]),
      { mode: 0o600 },
    );
    await runDueBackups({ sys: missing, dataDir: w2.dataDir, root: w2.root, dbConfig: dbConfig('pw'), now: () => 1728470400000 });
    expect(readSchedules(missing, w2.dataDir)[0]).toMatchObject({ id: 's1', lastStatus: expect.stringContaining('zip') });
  });
});
