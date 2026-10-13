import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { Connection as MysqlConn, FieldPacket, RowDataPacket } from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import type { FastifyInstance } from 'fastify';

/** Supported database engines. */
export type DbEngine = 'mysql' | 'postgres';

/** Connection settings (persisted to `db.json`, password included, `0600`). */
export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** One result row with JSON-safe cells. */
export interface DbRow {
  [col: string]: unknown;
}

/** Query outcome: columns, rows, and affected-row count when known. */
export interface DbResult {
  fields: string[];
  rows: DbRow[];
  affected: number | null;
}

/**
 * Live driver handle. `handle` is the vendor connection
 * (`mysql2` Connection or `pg` Client); only the matching driver touches it.
 */
export interface DbConn {
  readonly engine: DbEngine;
  readonly handle: unknown;
}

/**
 * Engine driver. All methods throw `Error` with the driver message on
 * failure (routes map to HTTP shapes). `listTables`/`previewRows` take
 * the stored config because PostgreSQL has no `USE`: they open their own
 * short-lived connection to the target database.
 */
export interface DbDriver {
  test(cfg: DbConfig): Promise<void>;
  connect(cfg: DbConfig): Promise<DbConn>;
  query(conn: DbConn, sql: string, params?: unknown[]): Promise<DbResult>;
  listDatabases(conn: DbConn): Promise<string[]>;
  listTables(cfg: DbConfig, db: string): Promise<string[]>;
  previewRows(cfg: DbConfig, db: string, table: string): Promise<DbResult>;
  close(conn: DbConn): Promise<void>;
  /** CREATE DATABASE (short-lived conn, identifier-escaped). */
  createDatabase(cfg: DbConfig, name: string): Promise<void>;
  /** Per-table rows (approximate on InnoDB/pg) + byte sizes. */
  tableStats(cfg: DbConfig, db: string): Promise<TableStat[]>;
  /** Exact DDL where the engine exposes it, else exact columns. */
  tableDef(cfg: DbConfig, db: string, table: string): Promise<TableDef>;
}

/** Per-table size/count row (rows may be engine-estimated). */
export interface TableStat {
  name: string;
  rows: number | null;
  dataBytes: number | null;
  indexBytes: number | null;
}

/** Table definition (ddl null where the engine exposes no exact text). */
export interface TableDef {
  ddl: string | null;
  columns: Array<{ name: string; type: string; nullable: boolean; def: string | null }> | null;
}

/** Persisted credential registry (`db.json` in production, memory in tests). */
export interface DbRegistry {
  load(): Partial<Record<DbEngine, DbConfig>>;
  save(cfgs: Partial<Record<DbEngine, DbConfig>>): void;
}

/** Inputs for {@link registerDatabaseRoutes}. */
export interface DatabaseOptions {
  registry: DbRegistry;
  drivers: Record<DbEngine, DbDriver>;
  live?: Map<DbEngine, DbConn>;
}

/** Engine defaults (Terwo parity). */
export function defaultDbConfig(engine: DbEngine): DbConfig {
  return engine === 'mysql'
    ? { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '' }
    : { host: '127.0.0.1', port: 5432, user: 'postgres', password: '', database: '' };
}

/** Coerce a partial body over engine defaults (Terwo `normCfg` parity). */
export function normalizeConfig(engine: DbEngine, body: Record<string, unknown>): DbConfig {
  const defaults = defaultDbConfig(engine);
  const port =
    Number.parseInt(
      typeof body['port'] === 'string' || typeof body['port'] === 'number' ? String(body['port']) : '',
      10,
    ) || defaults.port;
  return {
    host: typeof body['host'] === 'string' && body['host'] !== '' ? body['host'] : defaults.host,
    port,
    user: typeof body['user'] === 'string' && body['user'] !== '' ? body['user'] : defaults.user,
    password: body['password'] != null ? String(body['password']) : '',
    database: typeof body['database'] === 'string' ? body['database'] : '',
  };
}

/**
 * Make one cell JSON-safe: `Buffer` → utf8, `Date` → ISO, else passthrough
 * (Terwo `safeRow` parity, per cell).
 */
export function safeCell(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof Date) return value.toISOString();
  return value;
}

function safeRow(row: Record<string, unknown>): DbRow {
  const out: DbRow = {};
  for (const key of Object.keys(row)) out[key] = safeCell(row[key]);
  return out;
}

/** Quote a PostgreSQL identifier with `"`-doubling. */
export function quotePgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** File-backed registry in the server data dir (mode `0600`). */
export function fileRegistry(dataDir: string): DbRegistry {
  const file = join(dataDir, 'db.json');
  return {
    load: () => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return typeof parsed === 'object' && parsed !== null
          ? (parsed as Partial<Record<DbEngine, DbConfig>>)
          : {};
      } catch {
        return {};
      }
    },
    save: (cfgs) => writeFileSync(file, JSON.stringify(cfgs, null, 2), { mode: 0o600 }),
  };
}

function asMysql(conn: DbConn): MysqlConn {
  return conn.handle as MysqlConn;
}

function asPg(conn: DbConn): PgClient {
  return conn.handle as PgClient;
}

/** Production `mysql2` driver. */
export function mysqlDriver(): DbDriver {
  const open = (cfg: DbConfig, timeoutMs: number): Promise<MysqlConn> =>
    mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database === '' ? undefined : cfg.database,
      connectTimeout: timeoutMs,
    });
  return {
    test: async (cfg) => {
      const conn = await open(cfg, 5000);
      await conn.end();
    },
    connect: async (cfg) => ({ engine: 'mysql', handle: await open(cfg, 8000) }),
    query: async (conn, sql, params = []) => {
      const [rows, fields] = await asMysql(conn).query(sql, params as string[] & number[] & object[]);
      if (Array.isArray(rows)) {
        return {
          fields: (fields as FieldPacket[]).map((f) => f.name),
          rows: (rows as RowDataPacket[]).map((r) => safeRow(r as Record<string, unknown>)),
          affected: null,
        };
      }
      const affected =
        typeof (rows as { affectedRows?: unknown }).affectedRows === 'number'
          ? (rows as { affectedRows: number }).affectedRows
          : null;
      return { fields: [], rows: [], affected };
    },
    listDatabases: async (conn) => {
      const [rows] = await asMysql(conn).query('SHOW DATABASES');
      return (rows as Array<{ Database: string }>).map((r) => r.Database);
    },
    listTables: async (cfg, db) => {
      const conn = await open({ ...cfg, database: '' }, 5000);
      try {
        const [rows] = await conn.query(
          'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=? ORDER BY table_name',
          [db],
        );
        return (rows as Array<{ t: string }>).map((r) => r.t);
      } finally {
        await conn.end().catch(() => '');
      }
    },
    previewRows: async (cfg, db, table) => {
      const conn = await open({ ...cfg, database: '' }, 5000);
      try {
        const [rows, fields] = await conn.query('SELECT * FROM ??.?? LIMIT 50', [db, table]);
        return {
          fields: (fields as FieldPacket[]).map((f) => f.name),
          rows: (rows as RowDataPacket[]).map((r) => safeRow(r as Record<string, unknown>)),
          affected: null,
        };
      } finally {
        await conn.end().catch(() => '');
      }
    },
    close: async (conn) => {
      await asMysql(conn).end();
    },
    createDatabase: async (cfg, name) => {
      const conn = await open({ ...cfg, database: '' }, 8000);
      try {
        await conn.query('CREATE DATABASE ??', [name]);
      } finally {
        await conn.end().catch(() => '');
      }
    },
    tableStats: async (cfg, db) => {
      const conn = await open({ ...cfg, database: '' }, 5000);
      try {
        const [rows] = await conn.query(
          'SELECT table_name AS t, table_rows AS r, data_length AS d, index_length AS x FROM information_schema.tables WHERE table_schema=? ORDER BY table_name',
          [db],
        );
        return (rows as Array<{ t: string; r: number | null; d: number | null; x: number | null }>).map((r) => ({
          name: r.t,
          rows: typeof r.r === 'number' ? r.r : null,
          dataBytes: typeof r.d === 'number' ? r.d : null,
          indexBytes: typeof r.x === 'number' ? r.x : null,
        }));
      } finally {
        await conn.end().catch(() => '');
      }
    },
    tableDef: async (cfg, db, table) => {
      const conn = await open({ ...cfg, database: '' }, 5000);
      try {
        const [created] = await conn.query('SHOW CREATE TABLE ??.??', [db, table]);
        const ddlRow = (created as Array<Record<string, unknown>>)[0];
        if (ddlRow === undefined) throw new Error('Table not found');
        const ddlText = String(Object.values(ddlRow)[1] ?? '');
        const [cols] = await conn.query(
          'SELECT column_name AS n, column_type AS t, is_nullable AS nu, column_default AS d FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',
          [db, table],
        );
        return {
          ddl: ddlText === '' ? null : ddlText,
          columns: (cols as Array<{ n: string; t: string; nu: string; d: unknown }>).map((c) => ({
            name: c.n,
            type: c.t,
            nullable: c.nu === 'YES',
            def: c.d === null || c.d === undefined ? null : String(c.d),
          })),
        };
      } finally {
        await conn.end().catch(() => '');
      }
    },
  };
}

/** Production `pg` driver (short-lived clients per target database). */
export function pgDriver(): DbDriver {
  const open = async (cfg: DbConfig, database: string, timeoutMs: number): Promise<PgClient> => {
    const client = new PgClient({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database,
      connectionTimeoutMillis: timeoutMs,
    });
    await client.connect();
    return client;
  };
  const withDb = async <T>(cfg: DbConfig, db: string, fn: (client: PgClient) => Promise<T>): Promise<T> => {
    const client = await open(cfg, db, 5000);
    try {
      return await fn(client);
    } finally {
      try {
        await client.end();
      } catch {
        // ignore close errors on short-lived clients
      }
    }
  };
  return {
    test: async (cfg) => {
      const client = await open(cfg, cfg.database === '' ? 'postgres' : cfg.database, 5000);
      await client.end();
    },
    connect: async (cfg) => ({
      engine: 'postgres',
      handle: await open(cfg, cfg.database === '' ? 'postgres' : cfg.database, 8000),
    }),
    query: async (conn, sql, params = []) => {
      const result = await asPg(conn).query(sql, params as never[]);
      return {
        fields: result.fields.map((f) => f.name),
        rows: result.rows.map((r) => safeRow(r as Record<string, unknown>)),
        affected: typeof result.rowCount === 'number' ? result.rowCount : null,
      };
    },
    listDatabases: async (conn) => {
      const result = await asPg(conn).query(
        'SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname',
      );
      return (result.rows as Array<{ datname: string }>).map((r) => r.datname);
    },
    listTables: async (cfg, db) =>
      withDb(cfg, db, async (client) => {
        const result = await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY tablename",
        );
        return (result.rows as Array<{ tablename: string }>).map((r) => r.tablename);
      }),
    previewRows: async (cfg, db, table) =>
      withDb(cfg, db, async (client) => {
        const result = await client.query(`SELECT * FROM ${quotePgIdent(table)} LIMIT 50`);
        return {
          fields: result.fields.map((f) => f.name),
          rows: result.rows.map((r) => safeRow(r as Record<string, unknown>)),
          affected: null,
        };
      }),
    close: async (conn) => {
      await asPg(conn).end();
    },
    createDatabase: async (cfg, name) => {
      const client = await open(cfg, 'postgres', 8000);
      try {
        await client.query(`CREATE DATABASE ${quotePgIdent(name)}`);
      } finally {
        await client.end().catch(() => '');
      }
    },
    tableStats: async (cfg, db) =>
      withDb(cfg, db, async (client) => {
        const result = await client.query(
          `SELECT relname AS t, reltuples::bigint AS r, pg_relation_size(oid) AS d, pg_indexes_size(oid) AS x
           FROM pg_class WHERE relkind = 'r' AND relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
           ORDER BY relname`,
        );
        return (result.rows as Array<{ t: string; r: string | number | null; d: string | number | null; x: string | number | null }>).map((r) => ({
          name: r.t,
          rows: r.r === null ? null : Number(r.r),
          dataBytes: r.d === null ? null : Number(r.d),
          indexBytes: r.x === null ? null : Number(r.x),
        }));
      }),
    tableDef: async (cfg, db, table) =>
      withDb(cfg, db, async (client) => {
        const result = await client.query(
          `SELECT column_name AS n, data_type AS t, is_nullable AS nu, column_default AS d
           FROM information_schema.columns WHERE table_catalog = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [db, table],
        );
        return {
          ddl: null,
          columns: (result.rows as Array<{ n: string; t: string; nu: string; d: unknown }>).map((c) => ({
            name: c.n,
            type: c.t,
            nullable: c.nu === 'YES',
            def: c.d === null || c.d === undefined ? null : String(c.d),
          })),
        };
      }),
  };
}

const ENGINES: DbEngine[] = ['mysql', 'postgres'];

function storedConfig(registry: DbRegistry, engine: DbEngine): DbConfig {
  return { ...defaultDbConfig(engine), ...registry.load()[engine] };
}

function strQuery(query: unknown, key: string): string {
  if (typeof query !== 'object' || query === null) return '';
  const value = (query as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/** Valid database identifiers (letters, digits, `_`, `$`; 1–64 chars). */
export function validDbName(name: string): boolean {
  return /^[A-Za-z0-9_$]+$/.test(name) && name.length <= 64;
}

/**
 * System databases excluded from full-system bundle enumeration
 * (spec-bundle-wave §2; exact case-sensitive match so user DBs
 * like `Mysql` are never hidden).
 */
const SYSTEM_DATABASES: Record<DbEngine, ReadonlySet<string>> = {
  mysql: new Set(['information_schema', 'mysql', 'performance_schema', 'sys']),
  postgres: new Set(['postgres', 'template0', 'template1']),
};

/** True when `name` is a system database for `engine`. */
export function isSystemDatabase(engine: DbEngine, name: string): boolean {
  return SYSTEM_DATABASES[engine].has(name);
}

/** Drop system databases, preserving order (bundle enumerate step). */
export function filterUserDatabases(engine: DbEngine, names: string[]): string[] {
  return names.filter((name) => !isSystemDatabase(engine, name));
}

/** Map CREATE DATABASE driver errors to HTTP shapes. */
function createStatus(message: string): number {
  if (/database exists|already exists|42P04|\b1007\b/i.test(message)) return 409;
  if (/denied|not allowed|permission|42501|1044|1045|1142/i.test(message)) return 403;
  return 500;
}

/**
 * Register database-manager endpoints (all behind the session gate).
 * `test` always answers HTTP 200 (Terwo quirk parity); other failures
 * propagate to the app error handler (400 `{error}`).
 */
export function registerDatabaseRoutes(app: FastifyInstance, opts: DatabaseOptions): void {
  const live = opts.live ?? new Map<DbEngine, DbConn>();

  for (const engine of ENGINES) {
    const driver = opts.drivers[engine];
    const base = `/api/db/${engine}`;

    app.get(`${base}/config`, async () => ({
      config: storedConfig(opts.registry, engine),
      connected: live.has(engine),
    }));

    app.post(`${base}/config`, { bodyLimit: 1024 * 1024 }, async (req) => {
      const body = ((req.body ?? {}) as Record<string, unknown>);
      const cfgs = opts.registry.load();
      cfgs[engine] = normalizeConfig(engine, body);
      opts.registry.save(cfgs);
      return { ok: true };
    });

    app.post(`${base}/test`, { bodyLimit: 1024 * 1024 }, async (req) => {
      const body = ((req.body ?? {}) as Record<string, unknown>);
      try {
        await driver.test(normalizeConfig(engine, body));
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message === '' ? 'Connection failed' : message };
      }
    });

    app.post(`${base}/connect`, { bodyLimit: 1024 * 1024 }, async (req) => {
      const body = ((req.body ?? {}) as Record<string, unknown>);
      const cfg = normalizeConfig(engine, body);
      const cfgs = opts.registry.load();
      cfgs[engine] = cfg;
      opts.registry.save(cfgs);
      const old = live.get(engine);
      if (old !== undefined) {
        live.delete(engine);
        await driver.close(old).catch(() => '');
      }
      try {
        const conn = await driver.connect(cfg);
        live.set(engine, conn);
        const databases = await driver.listDatabases(conn);
        return { ok: true, databases };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Connection failed: ${message === '' ? 'unknown' : message}`);
      }
    });

    app.post(`${base}/disconnect`, async () => {
      const old = live.get(engine);
      if (old !== undefined) {
        live.delete(engine);
        await driver.close(old).catch(() => '');
      }
      return { ok: true };
    });

    app.get(`${base}/databases`, async () => {
      const conn = live.get(engine);
      if (conn === undefined) throw new Error('Not connected');
      return { databases: await driver.listDatabases(conn) };
    });

    app.post(`${base}/databases`, { bodyLimit: 1024 * 1024 }, async (req, reply) => {
      const conn = live.get(engine);
      if (conn === undefined) throw new Error('Not connected');
      const body = ((req.body ?? {}) as Record<string, unknown>);
      const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
      if (!validDbName(name)) {
        reply.code(400);
        return { error: 'Invalid database name (letters, digits, _ and $, max 64)' };
      }
      try {
        await driver.createDatabase(storedConfig(opts.registry, engine), name);
        return { ok: true, databases: await driver.listDatabases(conn) };
      } catch (err) {
        const message = err instanceof Error && err.message !== '' ? err.message : 'Create failed';
        reply.code(createStatus(message));
        return { error: message };
      }
    });

    app.get(`${base}/schema`, async (req) => {
      const conn = live.get(engine);
      if (conn === undefined) throw new Error('Not connected');
      const db = strQuery(req.query, 'db');
      if (db === '') throw new Error('Database must be selected');
      return { tables: await driver.tableStats(storedConfig(opts.registry, engine), db) };
    });

    app.get(`${base}/ddl`, async (req) => {
      const conn = live.get(engine);
      if (conn === undefined) throw new Error('Not connected');
      const db = strQuery(req.query, 'db');
      const table = strQuery(req.query, 'table');
      if (db === '' || table === '') throw new Error('Database and table are required');
      if (db.length > 128 || table.length > 128) throw new Error('Name too long');
      return driver.tableDef(storedConfig(opts.registry, engine), db, table);
    });

    app.get(`${base}/tables`, async (req) => {
      const conn = live.get(engine);
      if (conn === undefined) throw new Error('Not connected');
      const db = strQuery(req.query, 'db');
      if (db === '') throw new Error('Database must be selected');
      return { tables: await driver.listTables(storedConfig(opts.registry, engine), db) };
    });

    app.get(`${base}/rows`, async (req) => {
      const conn = live.get(engine);
      if (conn === undefined) throw new Error('Not connected');
      const db = strQuery(req.query, 'db');
      const table = strQuery(req.query, 'table');
      if (db === '' || table === '') throw new Error('Database and table are required');
      if (db.length > 128 || table.length > 128) throw new Error('Name too long');
      return driver.previewRows(storedConfig(opts.registry, engine), db, table);
    });

    app.post(`${base}/query`, { bodyLimit: 1024 * 1024 }, async (req) => {
      const conn = live.get(engine);
      if (conn === undefined) throw new Error('Not connected');
      const body = ((req.body ?? {}) as Record<string, unknown>);
      const sql = typeof body['sql'] === 'string' ? body['sql'].trim() : '';
      if (sql === '') throw new Error('SQL is empty');
      if (sql.length > 20000) throw new Error('SQL too long');
      return driver.query(conn, sql, []);
    });
  }
}
