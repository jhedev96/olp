import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { defaultExec } from './exec.js';
import { relOf, safePath } from './files.js';
import { nextRunMs, parseCronSchedule } from './cron-schedule.js';
import { cronJobLine, findMissingCronJobs, parseCronExport, parseCronLine } from './cron.js';
import type { CronJob } from './cron.js';
import type { DbConfig, DbEngine } from './database.js';
import { filterUserDatabases, quotePgIdent, validDbName } from './database.js';

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
  writeFile(path: string, data: string | Buffer, opts?: { mode?: number }): void;
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
  /** Bundle discovery (absent → bundle endpoints answer unavailable). */
  bundle?: BundleDiscovery;
}

/** Full-system bundle part kinds (manifest-level; archives reuse normal sidecars). */
export type BundlePartKind = 'mysql' | 'postgres' | 'configs' | 'crons';

/** One bundle part (every part is a normal verified archive). */
export interface BundlePart {
  name: string;
  file: string;
  kind: BundlePartKind;
  sha256: string;
}

/** Bundle manifest (persisted `<id>.bundle.json` in the backups dir, `0600`). */
export interface BundleManifest {
  id: string;
  created: number;
  parts: BundlePart[];
}

/** One snapshot step (live status for the bundles UI poll). */
export interface BundleStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'ok' | 'failed';
  detail: string;
}

/** Snapshot job record (memory-only; the manifest persists on success). */
export interface BundleJob {
  id: string;
  state: 'running' | 'done' | 'failed';
  steps: BundleStep[];
  started: number;
  finished: number | null;
}

/** Snapshot selection (defaults: all discovered DBs + configs + crons). */
export interface BundleSelection {
  databases?: { mysql?: string[]; postgres?: string[] };
  configs?: boolean;
  crons?: boolean;
}

/** Snapshot discovery deps (production wires drivers/cron in `index.ts`). */
export interface BundleDiscovery {
  /** Raw database names per engine (unfiltered; failures read as `[]`). */
  listDatabases: (engine: DbEngine) => Promise<string[]>;
  readCronJobs: () => Promise<CronJob[]>;
  /** Raw crontab lines (foreign lines preserved on restore). */
  readCronLines: () => Promise<string[]>;
  /** Replace the whole crontab (restore re-creates missing jobs only). */
  writeCronLines: (lines: string[]) => Promise<void>;
}

/** Inputs for {@link runBundleSnapshot} (shared by the route and tests). */
export interface BundleSnapshotDeps {
  sys: BackupSystem;
  dataDir: string;
  root: string;
  dbConfig: (engine: 'mysql' | 'postgres') => DbConfig;
  now: () => number;
  discovery: BundleDiscovery;
}

/** Panel config files staged into the configs part (auth `config.json` excluded → CAND-038). */
const BUNDLE_CONFIG_FILES = ['sites.json', 'db.json', 'settings.json', 'nginx.json'];

/** Snapshot selection cap (documented; keeps enumerate intersections small). */
const BUNDLE_SELECT_CAP = 50;

/** Step detail cap (documented; keeps job payloads small). */
const BUNDLE_DETAIL_CAP = 200;

/** Recent bundle jobs kept in memory (documented; the manifest is the durable record). */
const BUNDLE_JOBS_KEPT = 20;

function bundleManifestPath(dataDir: string, id: string): string {
  return join(backupsDir(dataDir), `${id}.bundle.json`);
}

function isBundlePartKind(value: unknown): value is BundlePartKind {
  return value === 'mysql' || value === 'postgres' || value === 'configs' || value === 'crons';
}

/**
 * Shape-validate a manifest (corrupt/missing files read as `null`,
 * never throw — a bad bundle must not break the list).
 */
export function readBundleManifest(sys: BackupSystem, dataDir: string, id: string): BundleManifest | null {
  const raw = sys.readFile(bundleManifestPath(dataDir, id));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['id'] !== 'string' || typeof obj['created'] !== 'number' || !Array.isArray(obj['parts'])) {
      return null;
    }
    const parts: BundlePart[] = [];
    for (const entry of obj['parts']) {
      if (typeof entry !== 'object' || entry === null) return null;
      const part = entry as Record<string, unknown>;
      if (
        typeof part['name'] !== 'string' ||
        typeof part['file'] !== 'string' ||
        !isBundlePartKind(part['kind']) ||
        typeof part['sha256'] !== 'string'
      ) {
        return null;
      }
      parts.push({ name: part['name'], file: part['file'], kind: part['kind'], sha256: part['sha256'] });
    }
    return { id: obj['id'], created: obj['created'], parts };
  } catch {
    return null;
  }
}

/** Newest-first manifests (corrupt files skipped). */
export function listBundleManifests(sys: BackupSystem, dataDir: string): BundleManifest[] {
  let names: string[];
  try {
    names = sys.listDir(backupsDir(dataDir));
  } catch {
    return [];
  }
  const out: BundleManifest[] = [];
  for (const file of names) {
    if (!file.endsWith('.bundle.json')) continue;
    const manifest = readBundleManifest(sys, dataDir, file.slice(0, -'.bundle.json'.length));
    if (manifest !== null) out.push(manifest);
  }
  out.sort((a, b) => b.created - a.created);
  return out;
}

/** Fresh running job (routes register it before kicking the run). */
export function createBundleJob(id: string, started: number): BundleJob {
  return { id, state: 'running', steps: [], started, finished: null };
}

function capDetail(text: string): string {
  return text === '' ? 'failed' : text.slice(0, BUNDLE_DETAIL_CAP);
}

/**
 * Run one full-system snapshot: enumerate → per-DB dumps → configs →
 * crons → manifest. Dump parts reuse `createArchive` (same bytes as
 * manual dumps). A failing step marks the job `failed` and stops;
 * earlier parts stay as normal visible archives. Never rejects (all
 * failures land on the job record).
 */
export async function runBundleSnapshot(
  deps: BundleSnapshotDeps,
  job: BundleJob,
  selection: BundleSelection,
): Promise<BundleJob> {
  const { sys, dataDir } = deps;
  const dir = backupsDir(dataDir);
  const fail = (step: BundleStep, err: unknown): BundleJob => {
    const message = err instanceof Error ? err.message : String(err);
    step.status = 'failed';
    step.detail = capDetail(message);
    job.state = 'failed';
    job.finished = deps.now();
    return job;
  };
  try {
    // 1. enumerate (per-engine list failures read as honest empties so
    // engine-less boxes still snapshot configs + crons).
    const discovered: Record<DbEngine, string[]> = { mysql: [], postgres: [] };
    const notes: string[] = [];
    for (const engine of ['mysql', 'postgres'] as const) {
      let raw: string[];
      try {
        raw = await deps.discovery.listDatabases(engine);
      } catch {
        raw = [];
        notes.push(`${engine}: list failed`);
      }
      const users = [...new Set(filterUserDatabases(engine, raw))];
      const wanted = selection.databases?.[engine];
      discovered[engine] = wanted === undefined ? users : users.filter((db) => wanted.includes(db));
    }
    const summary = `mysql: ${discovered.mysql.length}, postgres: ${discovered.postgres.length}`;
    job.steps.push({
      key: 'enumerate',
      label: 'Discover databases',
      status: 'ok',
      detail: notes.length > 0 ? `${summary} (${notes.join('; ')})` : summary,
    });

    const parts: BundlePart[] = [];
    const plan: Array<{ key: string; label: string; run: () => Promise<string> }> = [];
    for (const engine of ['mysql', 'postgres'] as const) {
      for (const db of discovered[engine]) {
        plan.push({
          key: `dump-${engine}-${db}`,
          label: `Dump ${engine} ${db}`,
          run: async () => {
            const created = await createArchive(sys, dataDir, deps.root, deps.dbConfig, deps.now, {
              type: engine,
              name: sanitizeBackupName(`${job.id}--${engine}-${db}`, () => `${job.id}--${engine}-db`),
              source: db,
              gzip: true,
            });
            const meta = readMeta(sys, dataDir, created.name);
            parts.push({ name: created.name, file: created.file, kind: engine, sha256: meta?.sha256 ?? '' });
            return created.file;
          },
        });
      }
    }
    if (selection.configs !== false) {
      plan.push({
        key: 'configs',
        label: 'Bundle configs',
        run: async () => {
          const staging = join(dir, `.staging-${job.id}`);
          const staged: string[] = [];
          try {
            sys.mkdirp(staging);
            for (const file of BUNDLE_CONFIG_FILES) {
              const raw = sys.readFile(join(dataDir, file));
              if (raw === null) continue;
              const dest = join(staging, file);
              sys.writeFile(dest, raw);
              staged.push(dest);
            }
            if (staged.length === 0) return 'no config files present';
            await mustBin(sys, 'zip', 'Package "zip" is not installed — install it first via the Store menu');
            const name = sanitizeBackupName(`${job.id}--configs`, () => `${job.id}--configs`);
            const archive = `${name}.zip`;
            await sys.exec(`zip -rq ${quote(join(dir, archive))} .`, ARCHIVE_TIMEOUT_MS, { cwd: staging });
            const sha256 = await hashStream(sys.streamFile(join(dir, archive)));
            sys.writeFile(
              metaPath(dataDir, name),
              JSON.stringify({ name, file: archive, type: 'folder', source: `bundle:${job.id}/configs`, created: deps.now(), sha256 }, null, 2),
              { mode: 0o600 },
            );
            parts.push({ name, file: archive, kind: 'configs', sha256 });
            return `${staged.length} files -> ${archive}`;
          } finally {
            for (const dest of staged) sys.removeFile(dest);
          }
        },
      });
    }
    if (selection.crons !== false) {
      plan.push({
        key: 'crons',
        label: 'Export cron jobs',
        run: async () => {
          const jobs = await deps.discovery.readCronJobs();
          const name = sanitizeBackupName(`${job.id}--crons`, () => `${job.id}--crons`);
          const file = `${name}.crons.json`;
          sys.mkdirp(dir);
          sys.writeFile(join(dir, file), JSON.stringify(jobs, null, 2));
          const sha256 = await hashStream(sys.streamFile(join(dir, file)));
          sys.writeFile(
            metaPath(dataDir, name),
            JSON.stringify({ name, file, type: 'folder', source: `bundle:${job.id}/crons`, created: deps.now(), sha256 }, null, 2),
            { mode: 0o600 },
          );
          parts.push({ name, file, kind: 'crons', sha256 });
          return `${jobs.length} jobs -> ${file}`;
        },
      });
    }
    plan.push({
      key: 'manifest',
      label: 'Write manifest',
      run: async () => {
        sys.mkdirp(dir);
        sys.writeFile(
          bundleManifestPath(dataDir, job.id),
          JSON.stringify({ id: job.id, created: deps.now(), parts }, null, 2),
          { mode: 0o600 },
        );
        return `${parts.length} parts`;
      },
    });

    for (const item of plan) {
      const step: BundleStep = { key: item.key, label: item.label, status: 'running', detail: '' };
      job.steps.push(step);
      try {
        step.detail = await item.run();
        step.status = 'ok';
      } catch (err) {
        return fail(step, err);
      }
    }
    job.state = 'done';
    job.finished = deps.now();
    return job;
  } catch (err) {
    const step: BundleStep = { key: 'snapshot', label: 'Snapshot', status: 'pending', detail: '' };
    job.steps.push(step);
    return fail(step, err);
  }
}

/** Inputs for {@link runBundleRestore} (shared by the route and tests). */
export interface BundleRestoreDeps {
  sys: BackupSystem;
  dataDir: string;
  dbConfig: (engine: 'mysql' | 'postgres') => DbConfig;
  now: () => number;
  discovery: BundleDiscovery;
}

/** Reset one database so the archived dump replays onto an empty schema. */
async function resetDatabase(sys: BackupSystem, cfg: DbConfig, engine: DbEngine, db: string): Promise<void> {
  if (engine === 'mysql') {
    await mustBin(sys, 'mysql', 'mysql not found. Install mysql via the Store menu.');
    const pw = cfg.password === '' ? '' : ` --password=${quote(cfg.password)}`;
    const ident = `\`${db.replace(/`/g, '``')}\``;
    await sys.exec(
      `mysql -h ${quote(cfg.host)} -P ${quote(cfg.port)} -u ${quote(cfg.user)}${pw} -e ${quote(`DROP DATABASE IF EXISTS ${ident}; CREATE DATABASE ${ident}`)}`,
      ARCHIVE_TIMEOUT_MS,
    );
  } else {
    await mustBin(sys, 'psql', 'psql not found. Install postgres via the Store menu.');
    await sys.exec(
      `PGPASSWORD=${quote(cfg.password)} psql -h ${quote(cfg.host)} -p ${quote(cfg.port)} -U ${quote(cfg.user)} -d postgres -c ${quote(`DROP DATABASE IF EXISTS ${quotePgIdent(db)}; CREATE DATABASE ${quotePgIdent(db)}`)}`,
      ARCHIVE_TIMEOUT_MS,
    );
  }
}

/**
 * Replay one full-system bundle: per-DB reset + pipe-in, configs
 * unzip + shape-validate before overwrite, crons missing-only
 * re-creation. Per-part failures are recorded and the job CONTINUES
 * (`failed-if-any`, never silent). Never rejects.
 */
export async function runBundleRestore(
  deps: BundleRestoreDeps,
  manifest: BundleManifest,
  job: BundleJob,
): Promise<BundleJob> {
  const { sys, dataDir } = deps;
  const dir = backupsDir(dataDir);
  let failed = false;
  const stepFailed = (step: BundleStep, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    step.status = 'failed';
    step.detail = capDetail(message);
    failed = true;
  };

  for (const part of manifest.parts) {
    if (part.kind !== 'mysql' && part.kind !== 'postgres') continue;
    const step: BundleStep = { key: `restore-${part.kind}-${part.name}`, label: `Restore ${part.kind} ${part.name}`, status: 'running', detail: '' };
    job.steps.push(step);
    try {
      const meta = readMeta(sys, dataDir, part.name);
      if (meta === null) throw new Error('Archive sidecar is missing');
      if (!validDbName(meta.source)) throw new Error('Invalid database name in archive');
      const full = join(dir, part.file);
      if (sys.statFile(full) === null) throw new Error('Archive file is missing');
      const cfg = deps.dbConfig(part.kind);
      const gzipped = part.file.endsWith('.sql.gz');
      if (gzipped) await mustBin(sys, 'gzip', 'gzip not found.');
      await resetDatabase(sys, cfg, part.kind, meta.source);
      if (part.kind === 'mysql') {
        await sys.exec(
          gzipped ? `gzip -dc ${quote(full)} | ${mysqlCommand(cfg, 'mysql', meta.source, null, '<')}` : mysqlCommand(cfg, 'mysql', meta.source, full, '<'),
          ARCHIVE_TIMEOUT_MS,
        );
      } else {
        await sys.exec(
          gzipped ? `gzip -dc ${quote(full)} | ${pgCommand(cfg, 'psql', meta.source, null, '<')}` : pgCommand(cfg, 'psql', meta.source, full, '<'),
          ARCHIVE_TIMEOUT_MS,
        );
      }
      step.status = 'ok';
      step.detail = meta.source;
    } catch (err) {
      stepFailed(step, err);
    }
  }

  const configsPart = manifest.parts.find((part) => part.kind === 'configs');
  if (configsPart !== undefined) {
    const step: BundleStep = { key: 'restore-configs', label: 'Restore configs', status: 'running', detail: '' };
    job.steps.push(step);
    const staging = join(dir, `.staging-restore-${job.id}`);
    try {
      const meta = readMeta(sys, dataDir, configsPart.name);
      if (meta === null) throw new Error('Archive sidecar is missing');
      const full = join(dir, configsPart.file);
      if (sys.statFile(full) === null) throw new Error('Archive file is missing');
      await mustBin(sys, 'unzip', 'Package "unzip" is not installed — install it first via the Store menu');
      sys.mkdirp(staging);
      await sys.exec(`unzip -o ${quote(full)} -d ${quote(staging)}`, ARCHIVE_TIMEOUT_MS);
      const rows: Array<{ file: string; raw: string }> = [];
      for (const file of BUNDLE_CONFIG_FILES) {
        const raw = sys.readFile(join(staging, file));
        if (raw === null) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`Invalid config in bundle: ${file}`);
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error(`Invalid config in bundle: ${file}`);
        }
        rows.push({ file, raw });
      }
      if (rows.length === 0) {
        step.status = 'ok';
        step.detail = 'no config files in bundle';
      } else {
        for (const row of rows) sys.writeFile(join(dataDir, row.file), row.raw, { mode: 0o600 });
        step.status = 'ok';
        step.detail = `${rows.length} files applied`;
      }
    } catch (err) {
      stepFailed(step, err);
    } finally {
      for (const file of BUNDLE_CONFIG_FILES) sys.removeFile(join(staging, file));
    }
  }

  const cronsPart = manifest.parts.find((part) => part.kind === 'crons');
  if (cronsPart !== undefined) {
    const step: BundleStep = { key: 'restore-crons', label: 'Restore cron jobs', status: 'running', detail: '' };
    job.steps.push(step);
    try {
      const data = sys.readFile(join(dir, cronsPart.file));
      if (data === null) throw new Error('Archive file is missing');
      let wanted: CronJob[];
      try {
        wanted = parseCronExport(JSON.parse(data));
      } catch {
        throw new Error('Invalid cron export in bundle');
      }
      const lines = await deps.discovery.readCronLines();
      const existing: CronJob[] = [];
      for (const line of lines) {
        const found = parseCronLine(line);
        if (found !== null) existing.push(found);
      }
      const missing = findMissingCronJobs(existing, wanted);
      if (missing.length === 0) {
        step.status = 'ok';
        step.detail = '0 jobs missing (nothing to do)';
      } else {
        const fresh = missing.map((entry) => cronJobLine({ ...entry, id: randomBytes(4).toString('hex') }));
        await deps.discovery.writeCronLines([...lines, ...fresh]);
        step.status = 'ok';
        step.detail = `${fresh.length} jobs re-created`;
      }
    } catch (err) {
      stepFailed(step, err);
    }
  }

  job.state = failed ? 'failed' : 'done';
  job.finished = deps.now();
  return job;
}

/** Coerce a snapshot selection (unknown shapes throw for the 400 handler). */
export function parseBundleSelection(body: Record<string, unknown>): BundleSelection {  const out: BundleSelection = {};
  const dbs = body['databases'];
  if (dbs !== undefined) {
    if (typeof dbs !== 'object' || dbs === null || Array.isArray(dbs)) throw new Error('Invalid databases selection');
    const sel: { mysql?: string[]; postgres?: string[] } = {};
    for (const engine of ['mysql', 'postgres'] as const) {
      const list = (dbs as Record<string, unknown>)[engine];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length > BUNDLE_SELECT_CAP || !list.every((e) => typeof e === 'string')) {
        throw new Error('Invalid databases selection');
      }
      sel[engine] = [...(list as string[])];
    }
    out.databases = sel;
  }
  for (const key of ['configs', 'crons'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new Error(`Invalid ${key} selection`);
    out[key] = value;
  }
  return out;
}

/** Archive/DB operation timeout (120 s, Terwo parity). */
const ARCHIVE_TIMEOUT_MS = 120000;

/** Upload cap (50 MB, files-upload parity). */
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

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

/** Inputs for {@link createArchive} (shared by the route and the ticker). */
export interface ArchiveInput {
  type: BackupType;
  name: string;
  source: string;
  gzip: boolean;
}

/**
 * Create one archive end to end (validate → engine → sidecar+hash).
 * Errors carry the same messages as the manual route (single source
 * of truth for both paths).
 */
export async function createArchive(
  sys: BackupSystem,
  dataDir: string,
  root: string,
  dbConfig: (engine: 'mysql' | 'postgres') => DbConfig,
  now: () => number,
  input: ArchiveInput,
): Promise<{ name: string; file: string }> {
  const dir = backupsDir(dataDir);
  const name = sanitizeBackupName(input.name, () => `backup-${backupStamp()}`);
  sys.mkdirp(dir);
  if (readMeta(sys, dataDir, name) !== null) throw new Error('Backup name already taken');
  let file: string;
  let source: string;
  if (input.type === 'folder') {
    const src = safePath(root, input.source);
    if (sys.statFile(src) === null) throw new Error('Source not found');
    await mustBin(sys, 'zip', 'Package "zip" is not installed — install it first via the Store menu');
    file = `${name}.zip`;
    source = relOf(root, src);
    await sys.exec(`zip -rq ${quote(join(dir, file))} .`, ARCHIVE_TIMEOUT_MS, { cwd: src });
  } else {
    const dbName = input.source.trim();
    if (dbName === '') throw new Error('Database name is required');
    const cfg = dbConfig(input.type);
    source = dbName;
    file = input.gzip ? `${name}.sql.gz` : `${name}.sql`;
    const dest = join(dir, file);
    if (input.type === 'mysql') {
      await mustBin(sys, 'mysqldump', 'mysqldump not found. Install mysql via the Store menu.');
      if (input.gzip) {
        await mustBin(sys, 'gzip', 'gzip not found.');
        await sys.exec(`${mysqlCommand(cfg, 'mysqldump', dbName, null, '>')} | gzip > ${quote(dest)}`, ARCHIVE_TIMEOUT_MS);
      } else {
        await sys.exec(mysqlCommand(cfg, 'mysqldump', dbName, dest, '>'), ARCHIVE_TIMEOUT_MS);
      }
    } else {
      await mustBin(sys, 'pg_dump', 'pg_dump not found. Install postgres via the Store menu.');
      if (input.gzip) {
        await mustBin(sys, 'gzip', 'gzip not found.');
        await sys.exec(`${pgCommand(cfg, 'pg_dump', dbName, null, '>')} | gzip > ${quote(dest)}`, ARCHIVE_TIMEOUT_MS);
      } else {
        await sys.exec(pgCommand(cfg, 'pg_dump', dbName, dest, '>'), ARCHIVE_TIMEOUT_MS);
      }
    }
  }
  sys.writeFile(
    metaPath(dataDir, name),
    JSON.stringify({ name, file, type: input.type, source, created: now(), sha256: await hashStream(sys.streamFile(join(dir, file))) }, null, 2),
    { mode: 0o600 },
  );
  return { name, file };
}

/** One backup schedule (ticker-managed). */
export interface BackupSchedule {
  id: string;
  name: string;
  type: BackupType;
  source: string;
  schedule: string;
  enabled: boolean;
  created: number;
  lastRun: number | null;
  lastStatus: string | null;
}

/** Ticker cadence (documented; schedules resolve to the minute). */
export const SCHEDULE_TICK_MS = 60000;

function schedulesPath(dataDir: string): string {
  return join(backupsDir(dataDir), 'backup-schedules.json');
}

function validScheduleRow(row: unknown): row is BackupSchedule {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['name'] === 'string' &&
    (r['type'] === 'folder' || r['type'] === 'mysql' || r['type'] === 'postgres') &&
    typeof r['source'] === 'string' &&
    typeof r['schedule'] === 'string' &&
    typeof r['enabled'] === 'boolean' &&
    typeof r['created'] === 'number'
  );
}

/** Read schedules (corrupt/missing → [], never throws). */
export function readSchedules(sys: BackupSystem, dataDir: string): BackupSchedule[] {
  try {
    const parsed: unknown = JSON.parse(sys.readFile(schedulesPath(dataDir)) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validScheduleRow).map((r) => ({
      ...r,
      lastRun: typeof r.lastRun === 'number' ? r.lastRun : null,
      lastStatus: typeof r.lastStatus === 'string' ? r.lastStatus : null,
    }));
  } catch {
    return [];
  }
}

function writeSchedules(sys: BackupSystem, dataDir: string, list: BackupSchedule[]): void {
  sys.mkdirp(backupsDir(dataDir));
  sys.writeFile(schedulesPath(dataDir), JSON.stringify(list, null, 2), { mode: 0o600 });
}

/** Schedules due at `nowMs` (enabled + a firing minute reached). */
export function dueSchedules(schedules: BackupSchedule[], nowMs: number): BackupSchedule[] {
  return schedules.filter((s) => {
    if (!s.enabled) return false;
    const next = nextRunMs(s.schedule, s.lastRun ?? 0);
    return next !== null && next <= nowMs;
  });
}

/** Tick inputs (shared by the interval and tests). */
export interface TickDeps {
  sys: BackupSystem;
  dataDir: string;
  root: string;
  dbConfig: (engine: 'mysql' | 'postgres') => DbConfig;
  now: () => number;
}

/**
 * Run one scheduler tick: execute due schedules inline (auto names),
 * record lastRun/lastStatus per schedule (errors capped, never thrown
 * out — one failing schedule must not stall the rest).
 */
export async function runDueBackups(deps: TickDeps, nowMs: number = deps.now()): Promise<void> {
  const list = readSchedules(deps.sys, deps.dataDir);
  let changed = false;
  for (const sched of dueSchedules(list, nowMs)) {
    changed = true;
    try {
      await createArchive(deps.sys, deps.dataDir, deps.root, deps.dbConfig, deps.now, {
        type: sched.type,
        name: `${sched.name}-${backupStamp(new Date(nowMs))}`,
        source: sched.source,
        gzip: sched.type !== 'folder',
      });
      sched.lastRun = nowMs;
      sched.lastStatus = 'ok';
    } catch (err) {
      sched.lastRun = nowMs;
      const message = err instanceof Error ? err.message : String(err);
      sched.lastStatus = message === '' ? 'failed' : message.slice(0, 200);
    }
  }
  if (changed) writeSchedules(deps.sys, deps.dataDir, list);
}

/**
 * Start the 60 s scheduler tick (production; tests drive
 * `runDueBackups` directly). Returns a stopper. The timer is unrefed
 * so it never holds the process open on its own.
 */
export function startBackupScheduler(deps: TickDeps, intervalMs: number = SCHEDULE_TICK_MS): () => void {
  const timer = setInterval(() => {
    void runDueBackups(deps).catch(() => {
      // per-schedule errors are already recorded; nothing escapes
    });
  }, intervalMs);
  if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
    (timer as unknown as { unref(): void }).unref();
  }
  return () => clearInterval(timer);
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
    const created = await createArchive(sys, opts.dataDir, opts.root, opts.dbConfig, now, {
      type: body['type'],
      name: typeof body['name'] === 'string' ? body['name'] : '',
      source: strField(body, 'source'),
      gzip: body['gzip'] === true,
    });
    return { ok: true, name: created.name };
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

  app.post('/api/backups/upload', { bodyLimit: UPLOAD_MAX_BYTES + 1024 * 1024 }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    if (!isBackupType(body['type'])) throw new Error('Invalid type');
    const type = body['type'];
    const raw = typeof body['data'] === 'string' ? body['data'] : '';
    if (raw === '') throw new Error('Archive data is required');
    const data = Buffer.from(raw, 'base64');
    if (data.length > UPLOAD_MAX_BYTES) throw new Error('File too large (max 50 MB)');
    const ext = type === 'folder' ? '.zip' : '.sql';
    const name = sanitizeBackupName(body['name'], () => `upload-${backupStamp()}`);
    sys.mkdirp(dir);
    if (readMeta(sys, opts.dataDir, name) !== null) throw new Error('Backup name already taken');
    const file = `${name}${ext}`;
    sys.writeFile(join(dir, file), data);
    const sha256 = await hashStream(sys.streamFile(join(dir, file)));
    sys.writeFile(
      metaPath(opts.dataDir, name),
      JSON.stringify({ name, file, type, source: 'upload', created: now(), sha256 }, null, 2),
      { mode: 0o600 },
    );
    return { ok: true, name };
  });

  app.get('/api/backups/schedules', async () => {
    return {
      schedules: readSchedules(sys, opts.dataDir).map((s) => ({ ...s, nextRun: nextRunMs(s.schedule, s.lastRun ?? 0) ?? null })),
    };
  });

  app.post('/api/backups/schedules', { bodyLimit: 1024 * 1024 }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const type = body['type'];
    if (!isBackupType(type)) throw new Error('Invalid type');
    const schedule = typeof body['schedule'] === 'string' ? body['schedule'].trim() : '';
    if (parseCronSchedule(schedule) === null) throw new Error('Invalid schedule (5 cron fields required)');
    const source = strField(body, 'source').trim();
    if (source === '') throw new Error('Source is required');
    const list = readSchedules(sys, opts.dataDir);
    const row: BackupSchedule = {
      id: randomBytes(4).toString('hex'),
      name: sanitizeBackupName(body['name'], () => `${type}-scheduled`),
      type,
      source,
      schedule,
      enabled: body['enabled'] !== false,
      created: now(),
      lastRun: null,
      lastStatus: null,
    };
    list.push(row);
    writeSchedules(sys, opts.dataDir, list);
    return { ok: true, schedule: row };
  });

  app.delete('/api/backups/schedules/:id', async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const list = readSchedules(sys, opts.dataDir);
    if (!list.some((s) => s.id === id)) {
      reply.code(404);
      return { error: 'Unknown schedule' };
    }
    writeSchedules(
      sys,
      opts.dataDir,
      list.filter((s) => s.id !== id),
    );
    return { ok: true };
  });

  app.post('/api/backups/schedules/:id/toggle', async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const list = readSchedules(sys, opts.dataDir);
    const row = list.find((s) => s.id === id);
    if (row === undefined) {
      reply.code(404);
      return { error: 'Unknown schedule' };
    }
    row.enabled = !row.enabled;
    writeSchedules(sys, opts.dataDir, list);
    return { ok: true };
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

  const bundleJobs = new Map<string, BundleJob>();
  let bundleRunning: string | null = null;

  app.post('/api/bundles', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const discovery = opts.bundle;
    if (discovery === undefined) throw new Error('Bundles are not available');
    if (bundleRunning !== null) {
      reply.code(409);
      return { error: 'A bundle snapshot is already running' };
    }
    const selection = parseBundleSelection(((req.body ?? {}) as Record<string, unknown>));
    const id = `bundle-${backupStamp(new Date(now()))}-${randomBytes(4).toString('hex')}`;
    sys.mkdirp(dir);
    const job = createBundleJob(id, now());
    bundleJobs.set(id, job);
    if (bundleJobs.size > BUNDLE_JOBS_KEPT) {
      for (const [key, kept] of bundleJobs) {
        if (bundleJobs.size <= BUNDLE_JOBS_KEPT) break;
        if (kept.state !== 'running') bundleJobs.delete(key);
      }
    }
    bundleRunning = id;
    void runBundleSnapshot(
      { sys, dataDir: opts.dataDir, root: opts.root, dbConfig: opts.dbConfig, now, discovery },
      job,
      selection,
    ).finally(() => {
      if (bundleRunning === id) bundleRunning = null;
    });
    return { ok: true, id };
  });

  app.get('/api/bundles', async () => {
    sys.mkdirp(dir);
    return { bundles: listBundleManifests(sys, opts.dataDir) };
  });

  app.get('/api/bundles/:id', async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const bundle = validBackupName(id) ? readBundleManifest(sys, opts.dataDir, id) : null;
    const job = bundleJobs.get(id) ?? null;
    if (bundle === null && job === null) {
      reply.code(404);
      return { error: 'Unknown bundle' };
    }
    return { bundle, job };
  });

  const restoreJobs = new Map<string, BundleJob>();
  let restoreRunning: string | null = null;

  const pruneJobs = (jobs: Map<string, BundleJob>): void => {
    if (jobs.size <= BUNDLE_JOBS_KEPT) return;
    for (const [key, kept] of jobs) {
      if (jobs.size <= BUNDLE_JOBS_KEPT) break;
      if (kept.state !== 'running') jobs.delete(key);
    }
  };

  app.post('/api/bundles/:id/restore', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const manifest = validBackupName(id) ? readBundleManifest(sys, opts.dataDir, id) : null;
    if (manifest === null) {
      reply.code(404);
      return { error: 'Unknown bundle' };
    }
    const discovery = opts.bundle;
    if (discovery === undefined) throw new Error('Bundles are not available');
    if (restoreRunning !== null) {
      reply.code(409);
      return { error: 'A bundle restore is already running' };
    }
    const rid = `restore-${randomBytes(6).toString('hex')}`;
    const job = createBundleJob(rid, now());
    restoreJobs.set(rid, job);
    pruneJobs(restoreJobs);
    restoreRunning = rid;
    void runBundleRestore({ sys, dataDir: opts.dataDir, dbConfig: opts.dbConfig, now, discovery }, manifest, job).finally(() => {
      if (restoreRunning === rid) restoreRunning = null;
    });
    return { ok: true, id: rid };
  });

  app.get('/api/bundles/restores/:id', async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const job = restoreJobs.get(id) ?? null;
    if (job === null) {
      reply.code(404);
      return { error: 'Unknown restore' };
    }
    return { job };
  });
}
