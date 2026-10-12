import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { defaultExec } from './exec.js';
import { relOf, safePath } from './files.js';
import type { DbConfig } from './database.js';

/** Backup kinds: folder archives plus per-engine SQL dumps. */
export type BackupType = 'folder' | 'mysql' | 'postgres';

/** Sidecar record (`<name>.json`, mode `0600`). */
export interface BackupMeta {
  name: string;
  file: string;
  type: BackupType;
  source: string;
  created: number;
  /** Hex sha256 of the archive (absent on pre-hash sidecars). */
  sha256?: string;
}

/** Sidecar plus live archive stats (list endpoint shape). */
export interface BackupEntry extends BackupMeta {
  size: number;
  mtime: number;
}

/** Injected OS surface (real fs/shell in production, memory fakes in tests). */
export interface BackupSystem {
  exec(cmd: string, timeoutMs: number, opts?: { cwd?: string }): Promise<string>;
  hasBin(bin: string): Promise<boolean>;
  mkdirp(dir: string): void;
  listDir(dir: string): string[];
  readFile(path: string): string | null;
  writeFile(path: string, data: string, opts?: { mode?: number }): void;
  /** Missing files resolve silently (delete parity). */
  removeFile(path: string): void;
  statFile(path: string): { size: number; mtime: number; isFile: boolean } | null;
  streamFile(path: string): NodeJS.ReadableStream & AsyncIterable<string | Buffer>;
}

/** Inputs for {@link registerBackupRoutes}. */
export interface BackupOptions {
  /** Server data dir; archives + sidecars live in `<dataDir>/backups`. */
  dataDir: string;
  /** File-manager jail for folder sources/targets. */
  root: string;
  sys: BackupSystem;
  /** Shared database credential reader (single `db.json` source of truth). */
  dbConfig: (engine: 'mysql' | 'postgres') => DbConfig;
  now?: () => number;
}

/** Archive/DB operation timeout (120 s, Terwo parity). */
const ARCHIVE_TIMEOUT_MS = 120000;

/** Production system surface (real fs + `defaultExec`). */
export function nodeBackupSys(): BackupSystem {
  return {
    exec: (cmd, timeoutMs, opts = {}) => defaultExec(cmd, timeoutMs, opts),
    hasBin: async (bin) => {
      try {
        await defaultExec(`command -v ${bin} >/dev/null 2>&1`, 8000);
        return true;
      } catch {
        return false;
      }
    },
    mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
    listDir: (dir) => readdirSync(dir),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile: (path, data, opts = {}) => writeFileSync(path, data, { mode: opts.mode ?? 0o666 }),
    removeFile: (path) => {
      try {
        unlinkSync(path);
      } catch {
        // missing files resolve silently
      }
    },
    statFile: (path) => {
      try {
        const st = statSync(path);
        return { size: st.size, mtime: st.mtimeMs, isFile: st.isFile() };
      } catch {
        return null;
      }
    },
    streamFile: (path) => createReadStream(path),
  };
}

function backupsDir(dataDir: string): string {
  return join(dataDir, 'backups');
}

function metaPath(dataDir: string, name: string): string {
  return join(backupsDir(dataDir), `${name}.json`);
}

/** Local-time `YYYYMMDD-HHMMSS` stamp (`backupStamp` parity). */
export function backupStamp(at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/**
 * Normalize a backup name: default when blank, then map
 * `[^a-zA-Z0-9._-]` to `_` (Terwo parity).
 *
 * @throws `Invalid name` when nothing remains.
 */
export function sanitizeBackupName(raw: unknown, fallback: () => string): string {
  const base = typeof raw === 'string' ? raw.trim() : '';
  const name = (base === '' ? fallback() : base).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (name === '') throw new Error('Invalid name');
  return name;
}

/** URL-name guard (Terwo parity, quirks included — see spec §10). */
function validBackupName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

function readMeta(sys: BackupSystem, dataDir: string, name: string): BackupMeta | null {
  const raw = sys.readFile(metaPath(dataDir, name));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj['name'] !== 'string' ||
      typeof obj['file'] !== 'string' ||
      typeof obj['type'] !== 'string' ||
      typeof obj['source'] !== 'string'
    ) {
      return null;
    }
    return parsed as BackupMeta;
  } catch {
    return null;
  }
}

function isBackupType(value: unknown): value is BackupType {
  return value === 'folder' || value === 'mysql' || value === 'postgres';
}

function strField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/** Single-quote a shell value (paths, credentials, db names). */
function quote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function mustBin(sys: BackupSystem, bin: string, message: string): Promise<void> {
  if (await sys.hasBin(bin)) return;
  throw new Error(message);
}

/**
 * Hex sha256 over an archive stream (node:crypto, no new exec
 * surface). Stream failures reject (caller maps to 400/500). Real
 * streams are async-iterable at runtime; the intersection type says
 * so explicitly (minimal `@types/node` gap, no casts).
 */
export function hashStream(stream: NodeJS.ReadableStream & AsyncIterable<string | Buffer>): Promise<string> {
  return (async () => {
    const hash = createHash('sha256');
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  })();
}

function mysqlCommand(
  cfg: DbConfig,
  tool: 'mysqldump' | 'mysql',
  db: string,
  file: string | null,
  direction: '>' | '<',
): string {
  const pw = cfg.password === '' ? '' : ` --password=${quote(cfg.password)}`;
  const base =
    `${tool} -h ${quote(cfg.host)} -P ${quote(cfg.port)} -u ${quote(cfg.user)}${pw} ` + `${quote(db)}`;
  return file === null ? base : `${base} ${direction} ${quote(file)}`;
}

function pgCommand(cfg: DbConfig, tool: 'pg_dump' | 'psql', db: string, file: string | null, direction: '>' | '<'): string {
  const base = `${tool} -h ${quote(cfg.host)} -p ${quote(cfg.port)} -U ${quote(cfg.user)} -d ${quote(db)}`;
  const env = `PGPASSWORD=${quote(cfg.password)} `;
  return file === null ? `${env}${base}` : `${env}${base} ${direction} ${quote(file)}`;
}

/**
 * Register backup endpoints (all behind the session gate).
 * Thrown errors propagate to the app error handler (400 `{error}`).
 */
export function registerBackupRoutes(app: FastifyInstance, opts: BackupOptions): void {
  const { sys } = opts;
  const dir = backupsDir(opts.dataDir);
  const now = opts.now ?? Date.now;

  app.get('/api/backups', async () => {
    sys.mkdirp(dir);
    const out: BackupEntry[] = [];
    for (const file of sys.listDir(dir)) {
      if (!file.endsWith('.json')) continue;
      const meta = readMeta(sys, opts.dataDir, file.slice(0, -'.json'.length));
      if (meta === null) continue;
      const st = sys.statFile(join(dir, meta.file));
      if (st === null) continue;
      out.push({ ...meta, size: st.size, mtime: st.mtime });
    }
    out.sort((a, b) => b.created - a.created);
    return { backups: out };
  });

  app.post('/api/backups', { bodyLimit: 1024 * 1024 }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    if (!isBackupType(body['type'])) throw new Error('Invalid type');
    const type = body['type'];
    const name = sanitizeBackupName(body['name'], () => `backup-${backupStamp()}`);
    sys.mkdirp(dir);
    if (readMeta(sys, opts.dataDir, name) !== null) throw new Error('Backup name already taken');
    let file: string;
    let source: string;
    if (type === 'folder') {
      const src = safePath(opts.root, strField(body, 'source'));
      if (sys.statFile(src) === null) throw new Error('Source not found');
      await mustBin(sys, 'zip', 'Package "zip" is not installed — install it first via the Store menu');
      file = `${name}.zip`;
      source = relOf(opts.root, src);
      await sys.exec(`zip -rq ${quote(join(dir, file))} .`, ARCHIVE_TIMEOUT_MS, { cwd: src });
    } else {
      const dbName = strField(body, 'source').trim();
      if (dbName === '') throw new Error('Database name is required');
      const cfg = opts.dbConfig(type);
      source = dbName;
      const gzip = body['gzip'] === true;
      file = gzip ? `${name}.sql.gz` : `${name}.sql`;
      const dest = join(dir, file);
      if (type === 'mysql') {
        await mustBin(sys, 'mysqldump', 'mysqldump not found. Install mysql via the Store menu.');
        if (gzip) {
          await mustBin(sys, 'gzip', 'gzip not found.');
          await sys.exec(`${mysqlCommand(cfg, 'mysqldump', dbName, null, '>')} | gzip > ${quote(dest)}`, ARCHIVE_TIMEOUT_MS);
        } else {
          await sys.exec(mysqlCommand(cfg, 'mysqldump', dbName, dest, '>'), ARCHIVE_TIMEOUT_MS);
        }
      } else {
        await mustBin(sys, 'pg_dump', 'pg_dump not found. Install postgres via the Store menu.');
        if (gzip) {
          await mustBin(sys, 'gzip', 'gzip not found.');
          await sys.exec(`${pgCommand(cfg, 'pg_dump', dbName, null, '>')} | gzip > ${quote(dest)}`, ARCHIVE_TIMEOUT_MS);
        } else {
          await sys.exec(pgCommand(cfg, 'pg_dump', dbName, dest, '>'), ARCHIVE_TIMEOUT_MS);
        }
      }
    }
    sys.writeFile(
      metaPath(opts.dataDir, name),
      JSON.stringify({ name, file, type, source, created: now(), sha256: await hashStream(sys.streamFile(join(dir, file))) }, null, 2),
      { mode: 0o600 },
    );
    return { ok: true, name };
  });

  app.get('/api/backups/:name/verify', async (req) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const meta = validBackupName(name) ? readMeta(sys, opts.dataDir, name) : null;
    if (meta === null) throw new Error('Backup not found');
    const full = join(dir, meta.file);
    if (sys.statFile(full) === null) throw new Error('Backup file is missing');
    const sha256 = await hashStream(sys.streamFile(full));
    return { ok: true, sha256, match: meta.sha256 === undefined ? null : meta.sha256 === sha256 };
  });

  app.get('/api/backups/:name/download', async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const meta = validBackupName(name) ? readMeta(sys, opts.dataDir, name) : null;
    if (meta === null) throw new Error('Backup not found');
    const full = join(dir, meta.file);
    const st = sys.statFile(full);
    if (st === null || !st.isFile) throw new Error('Backup file is missing');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', st.size);
    reply.header('Content-Disposition', `attachment; filename="${meta.file.replace(/"/g, '')}"`);
    return reply.send(sys.streamFile(full));
  });

  app.delete('/api/backups/:name', async (req) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const meta = validBackupName(name) ? readMeta(sys, opts.dataDir, name) : null;
    if (meta === null) throw new Error('Backup not found');
    sys.removeFile(join(dir, meta.file));
    sys.removeFile(metaPath(opts.dataDir, name));
    return { ok: true };
  });

  app.post('/api/backups/:name/restore', { bodyLimit: 1024 * 1024 }, async (req) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const meta = validBackupName(name) ? readMeta(sys, opts.dataDir, name) : null;
    if (meta === null) throw new Error('Backup not found');
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const full = join(dir, meta.file);
    if (meta.type === 'folder') {
      const requested = strField(body, 'targetPath');
      const target = safePath(opts.root, requested === '' ? meta.source : requested);
      await mustBin(sys, 'unzip', 'Package "unzip" is not installed — install it first via the Store menu');
      sys.mkdirp(target);
      await sys.exec(`unzip -o ${quote(full)} -d ${quote(target)}`, ARCHIVE_TIMEOUT_MS);
    } else {
      const cfg = opts.dbConfig(meta.type);
      const gzipped = meta.file.endsWith('.sql.gz');
      if (gzipped) await mustBin(sys, 'gzip', 'gzip not found.');
      if (meta.type === 'mysql') {
        await mustBin(sys, 'mysql', 'mysql not found. Install mysql via the Store menu.');
        await sys.exec(
          gzipped ? `gzip -dc ${quote(full)} | ${mysqlCommand(cfg, 'mysql', meta.source, null, '<')}` : mysqlCommand(cfg, 'mysql', meta.source, full, '<'),
          ARCHIVE_TIMEOUT_MS,
        );
      } else {
        await mustBin(sys, 'psql', 'psql not found. Install postgres via the Store menu.');
        await sys.exec(
          gzipped ? `gzip -dc ${quote(full)} | ${pgCommand(cfg, 'psql', meta.source, null, '<')}` : pgCommand(cfg, 'psql', meta.source, full, '<'),
          ARCHIVE_TIMEOUT_MS,
        );
      }
    }
    return { ok: true };
  });
}
