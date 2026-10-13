import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { filterUserDatabases, isSystemDatabase, normalizeConfig, quotePgIdent, safeCell, validDbName } from '../src/database.js';
import type { DbConfig, DbConn, DbDriver, DbEngine, DbRegistry, DbResult } from '../src/database.js';

const KNOWN_PASSWORD = 'dbpass123';

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

interface FakeScript {
  testError?: string;
  connectError?: string;
  databases?: string[];
  tables?: string[];
  preview?: DbResult;
  queryResult?: DbResult;
  createError?: string;
  stats?: Array<{ name: string; rows: number | null; dataBytes: number | null; indexBytes: number | null }>;
  def?: { ddl: string | null; columns: Array<{ name: string; type: string; nullable: boolean; def: string | null }> | null };
}

function makeDriver(engine: DbEngine, script: FakeScript = {}): {
  driver: DbDriver;
  calls: Array<{ method: string; sql?: string; params?: unknown[]; cfg?: DbConfig; db?: string; table?: string }>;
  closed: number;
} {
  const calls: Array<{
    method: string;
    sql?: string;
    params?: unknown[];
    cfg?: DbConfig;
    db?: string;
    table?: string;
  }> = [];
  let closed = 0;
  let seq = 0;
  const driver: DbDriver = {
    test: async (cfg) => {
      calls.push({ method: 'test', cfg });
      if (script.testError !== undefined) throw new Error(script.testError);
    },
    connect: async (cfg) => {
      calls.push({ method: 'connect', cfg });
      if (script.connectError !== undefined) throw new Error(script.connectError);
      const conn: DbConn = { engine, handle: { seq: seq++ } };
      return conn;
    },
    query: async (_conn, sql, params = []) => {
      calls.push({ method: 'query', sql, params });
      return script.queryResult ?? { fields: [], rows: [], affected: 1 };
    },
    listDatabases: async () => {
      calls.push({ method: 'listDatabases' });
      return script.databases ?? ['appdb'];
    },
    listTables: async (cfg, db) => {
      calls.push({ method: 'listTables', cfg, db });
      return script.tables ?? ['users'];
    },
    previewRows: async (cfg, db, table) => {
      calls.push({ method: 'previewRows', cfg, db, table });
      return script.preview ?? { fields: ['id'], rows: [{ id: 1 }], affected: null };
    },
    createDatabase: async (cfg, name) => {
      calls.push({ method: 'createDatabase', cfg, db: name });
      if (script.createError !== undefined) throw new Error(script.createError);
    },
    tableStats: async (cfg, db) => {
      calls.push({ method: 'tableStats', cfg, db });
      return script.stats ?? [{ name: 'users', rows: 12, dataBytes: 16384, indexBytes: 0 }];
    },
    tableDef: async (cfg, db, table) => {
      calls.push({ method: 'tableDef', cfg, db, table });
      return script.def ?? { ddl: 'CREATE TABLE `users` (`id` int)', columns: null };
    },
    close: async () => {
      closed++;
    },
  };
  return {
    driver,
    calls,
    get closed() {
      return closed;
    },
  };
}

function memoryRegistry(): DbRegistry & { saved: Array<Partial<Record<DbEngine, DbConfig>>> } {
  let cfgs: Partial<Record<DbEngine, DbConfig>> = {};
  const saved: Array<Partial<Record<DbEngine, DbConfig>>> = [];
  return {
    saved,
    load: () => ({ ...cfgs }),
    save: (next) => {
      cfgs = { ...next };
      saved.push({ ...next });
    },
  };
}

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'db-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-db-'));
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

function testServer(
  drivers: Record<DbEngine, DbDriver>,
  registry: DbRegistry & { saved: Array<Partial<Record<DbEngine, DbConfig>>> },
): { app: FastifyInstance; registry: typeof registry } {
  const { dataDir, legacyDir, root } = freshWorkspace();
  const { app } = buildServer({
    dataDir,
    legacyDir,
    env: fakeEnv,
    sysDeps: quietDeps(),
    root,
    dbRegistry: registry,
    dbDrivers: drivers,
  });
  return { app, registry };
}

describe('database pure helpers', () => {
  it('normalizes over engine defaults', () => {
    expect(normalizeConfig('mysql', {})).toEqual({ host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '' });
    expect(normalizeConfig('postgres', { port: '5433', user: 'app', password: 42, database: 'x' })).toEqual({
      host: '127.0.0.1',
      port: 5433,
      user: 'app',
      password: '42',
      database: 'x',
    });
    expect(normalizeConfig('mysql', { port: 'nan' }).port).toBe(3306);
  });

  it('quotes pg idents and sanitizes cells', () => {
    expect(quotePgIdent('users')).toBe('"users"');
    expect(quotePgIdent('a"b')).toBe('"a""b"');
    expect(safeCell(Buffer.from('hi'))).toBe('hi');
    expect(safeCell(new Date('2024-01-02T03:04:05.000Z'))).toBe('2024-01-02T03:04:05.000Z');
    expect(safeCell(7)).toBe(7);
    expect(safeCell(null)).toBeNull();
  });

  it('validates database identifiers', () => {
    expect(validDbName('appdb')).toBe(true);
    expect(validDbName('a1_$')).toBe(true);
    expect(validDbName('')).toBe(false);
    expect(validDbName('has space')).toBe(false);
    expect(validDbName('semi;colon')).toBe(false);
    expect(validDbName('x'.repeat(64))).toBe(true);
    expect(validDbName('x'.repeat(65))).toBe(false);
  });

  it('excludes system databases per engine for bundle enumeration', () => {
    expect(filterUserDatabases('mysql', ['information_schema', 'mysql', 'performance_schema', 'sys', 'appdb', 'blog'])).toEqual([
      'appdb',
      'blog',
    ]);
    expect(filterUserDatabases('postgres', ['postgres', 'template0', 'template1', 'appdb'])).toEqual(['appdb']);
    expect(filterUserDatabases('mysql', [])).toEqual([]);
    expect(filterUserDatabases('postgres', ['postgres', 'template0', 'template1'])).toEqual([]);
    expect(isSystemDatabase('mysql', 'Mysql')).toBe(false);
    expect(isSystemDatabase('postgres', 'Postgres')).toBe(false);
  });
});

describe.each(['mysql', 'postgres'] as const)('server db routes (%s)', (engine) => {
  const base = `/api/db/${engine}`;

  function rig(script: FakeScript = {}) {
    const made = makeDriver(engine, script);
    const registry = memoryRegistry();
    const drivers = { mysql: makeDriver('mysql').driver, postgres: makeDriver('postgres').driver };
    drivers[engine] = made.driver;
    return { ...testServer(drivers, registry), made, registry };
  }

  it('gates with 401', async () => {
    const { app } = rig();
    expect((await app.inject({ method: 'GET', url: `${base}/config` })).statusCode).toBe(401);
  });

  it('reads and saves config with connected flag', async () => {
    const { app, registry } = rig();
    const cookie = await authedCookie(app);
    const get = await app.inject({ method: 'GET', url: `${base}/config`, headers: { cookie } });
    expect(get.json().connected).toBe(false);
    expect(get.json().config.host).toBe('127.0.0.1');

    const save = await app.inject({
      method: 'POST',
      url: `${base}/config`,
      headers: { cookie },
      payload: { host: 'db.local', port: '3307', user: 'app', password: 's3cret', database: 'appdb' },
    });
    expect(save.json()).toEqual({ ok: true });
    expect(registry.saved.at(-1)?.[engine]).toMatchObject({ host: 'db.local', port: 3307, user: 'app' });

    const conn = await app.inject({
      method: 'POST',
      url: `${base}/connect`,
      headers: { cookie },
      payload: { host: 'db.local', user: 'app', password: 's3cret' },
    });
    expect(conn.json().databases).toEqual(['appdb']);
    const flagged = await app.inject({ method: 'GET', url: `${base}/config`, headers: { cookie } });
    expect(flagged.json().connected).toBe(true);
  });

  it('tests with HTTP-200 shape on success and failure', async () => {
    const okRig = rig();
    const cookie = await authedCookie(okRig.app);
    const ok = await okRig.app.inject({
      method: 'POST',
      url: `${base}/test`,
      headers: { cookie },
      payload: { host: 'h', user: 'u', password: 'p' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const badRig = rig({ testError: 'ECONNREFUSED 127.0.0.1' });
    const cookie2 = await authedCookie(badRig.app);
    const bad = await badRig.app.inject({
      method: 'POST',
      url: `${base}/test`,
      headers: { cookie: cookie2 },
      payload: {},
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toEqual({ ok: false, error: 'ECONNREFUSED 127.0.0.1' });
  });

  it('connects, drops previous, and prefixes failures', async () => {
    const { app, made } = rig();
    const cookie = await authedCookie(app);
    const body = { host: 'h', user: 'u', password: 'p' };
    expect((await app.inject({ method: 'POST', url: `${base}/connect`, headers: { cookie }, payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${base}/connect`, headers: { cookie }, payload: body })).statusCode).toBe(200);
    expect(made.closed).toBe(1);

    const failing = rig({ connectError: 'Access denied' });
    const cookie2 = await authedCookie(failing.app);
    const res = await failing.app.inject({ method: 'POST', url: `${base}/connect`, headers: { cookie: cookie2 }, payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Connection failed: Access denied' });
    const dbs = await failing.app.inject({ method: 'GET', url: `${base}/databases`, headers: { cookie: cookie2 } });
    expect(dbs.statusCode).toBe(400);
    expect(dbs.json()).toEqual({ error: 'Not connected' });
  });

  it('disconnects idempotently', async () => {
    const { app, made } = rig();
    const cookie = await authedCookie(app);
    expect((await app.inject({ method: 'POST', url: `${base}/disconnect`, headers: { cookie } })).json()).toEqual({ ok: true });
    await app.inject({ method: 'POST', url: `${base}/connect`, headers: { cookie }, payload: {} });
    expect((await app.inject({ method: 'POST', url: `${base}/disconnect`, headers: { cookie } })).json()).toEqual({ ok: true });
    expect(made.closed).toBe(1);
  });

  it('browses databases tables rows with guards', async () => {
    const { app, made } = rig({
      databases: ['a', 'b'],
      tables: ['users'],
      preview: { fields: ['id'], rows: [{ id: 1 }], affected: null },
    });
    const cookie = await authedCookie(app);
    await app.inject({ method: 'POST', url: `${base}/connect`, headers: { cookie }, payload: {} });

    expect((await app.inject({ method: 'GET', url: `${base}/databases`, headers: { cookie } })).json()).toEqual({
      databases: ['a', 'b'],
    });
    const tables = await app.inject({ method: 'GET', url: `${base}/tables?db=a`, headers: { cookie } });
    expect(tables.json()).toEqual({ tables: ['users'] });
    expect((await app.inject({ method: 'GET', url: `${base}/tables`, headers: { cookie } })).statusCode).toBe(400);

    const rows = await app.inject({ method: 'GET', url: `${base}/rows?db=a&table=users`, headers: { cookie } });
    expect(rows.json()).toEqual({ fields: ['id'], rows: [{ id: 1 }], affected: null });
    expect((await app.inject({ method: 'GET', url: `${base}/rows?db=a`, headers: { cookie } })).statusCode).toBe(400);
    const long = 'x'.repeat(129);
    expect((await app.inject({ method: 'GET', url: `${base}/rows?db=${long}&table=t`, headers: { cookie } })).statusCode).toBe(400);

    const previewCall = made.calls.find((c) => c.method === 'previewRows' || c.method === 'query');
    expect(previewCall).toBeDefined();
  });

  it('passes identifiers through untouched', async () => {
    const { app, made } = rig();
    const cookie = await authedCookie(app);
    await app.inject({ method: 'POST', url: `${base}/connect`, headers: { cookie }, payload: {} });
    const weird = 'we"ird';
    await app.inject({ method: 'GET', url: `${base}/tables?db=${encodeURIComponent(weird)}`, headers: { cookie } });
    const tablesCall = made.calls.find((c) => c.method === 'listTables');
    expect(tablesCall?.db).toBe(weird);
  });

  it('runs ad-hoc SQL with caps', async () => {
    const { app, made } = rig({ queryResult: { fields: ['n'], rows: [{ n: 2 }], affected: null } });
    const cookie = await authedCookie(app);
    await app.inject({ method: 'POST', url: `${base}/connect`, headers: { cookie }, payload: {} });
    expect((await app.inject({ method: 'POST', url: `${base}/query`, headers: { cookie }, payload: { sql: 'SELECT 1' } })).json()).toEqual({
      fields: ['n'],
      rows: [{ n: 2 }],
      affected: null,
    });
    expect(made.calls.find((c) => c.method === 'query')?.params).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `${base}/query`, headers: { cookie }, payload: { sql: '   ' } })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: `${base}/query`, headers: { cookie }, payload: { sql: 'x'.repeat(20001) } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: `${base}/query`, headers: { cookie }, payload: { sql: 'SELECT 1' } })).statusCode,
    ).toBe(200);
    const idle = rig();
    const cookie2 = await authedCookie(idle.app);
    expect((await idle.app.inject({ method: 'POST', url: `${base}/query`, headers: { cookie: cookie2 }, payload: { sql: 'SELECT 1' } })).statusCode).toBe(400);
  });

  it('creates databases with validated names', async () => {
    const { app, made } = rig();
    const cookie = await authedCookie(app);
    await app.inject({ method: 'POST', url: `${base}/connect`, headers: { cookie }, payload: {} });
    const create = (name: unknown) =>
      app.inject({ method: 'POST', url: `${base}/databases`, headers: { cookie }, payload: { name } });
    expect((await create('')).statusCode).toBe(400);
    expect((await create('has space')).statusCode).toBe(400);
    expect((await create('x'.repeat(65))).statusCode).toBe(400);
    const ok = await create('appdb2');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, databases: ['appdb'] });
    expect(made.calls.find((c) => c.method === 'createDatabase')?.db).toBe('appdb2');
    const idle = rig();
    const cookie2 = await authedCookie(idle.app);
    expect(
      (await idle.app.inject({ method: 'POST', url: `${base}/databases`, headers: { cookie: cookie2 }, payload: { name: 'appdb2' } })).statusCode,
    ).toBe(400);
  });

  it('maps create errors to 409/403/500', async () => {
    for (const [message, status] of [
      ['Database exists', 409],
      ['Access denied for user', 403],
      ['permission denied to create database', 403],
      ['connection lost', 500],
    ] as const) {
      const { app } = rig({ createError: message });
      const cookie = await authedCookie(app);
      await app.inject({ method: 'POST', url: `${base}/connect`, headers: { cookie }, payload: {} });
      const res = await app.inject({ method: 'POST', url: `${base}/databases`, headers: { cookie }, payload: { name: 'appdb2' } });
      expect(res.statusCode).toBe(status);
      expect(typeof res.json().error).toBe('string');
    }
  });

  it('serves schema and ddl shapes', async () => {
    const stats = [{ name: 'users', rows: 12, dataBytes: 16384, indexBytes: 0 }];
    const def = {
      ddl: engine === 'mysql' ? 'CREATE TABLE `users` (`id` int)' : null,
      columns: [{ name: 'id', type: 'int', nullable: false, def: null }],
    };
    const { app, made } = rig({ stats, def });
    const cookie = await authedCookie(app);
    await app.inject({ method: 'POST', url: `${base}/connect`, headers: { cookie }, payload: {} });
    const schema = await app.inject({ method: 'GET', url: `${base}/schema?db=appdb`, headers: { cookie } });
    expect(schema.json()).toEqual({ tables: stats });
    expect(made.calls.find((c) => c.method === 'tableStats')?.db).toBe('appdb');
    const ddl = await app.inject({ method: 'GET', url: `${base}/ddl?db=appdb&table=users`, headers: { cookie } });
    expect(ddl.json()).toEqual(def);
    expect((await app.inject({ method: 'GET', url: `${base}/schema`, headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${base}/ddl?db=appdb`, headers: { cookie } })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `${base}/ddl?db=appdb&table=${'x'.repeat(129)}`, headers: { cookie } })).statusCode,
    ).toBe(400);
  });
});
