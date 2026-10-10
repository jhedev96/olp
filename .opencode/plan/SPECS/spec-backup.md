# SPEC — backup

> Module id: `backup` (part of `@olp/server`: folder zip + DB dump lifecycle).
> Owner: TBD. Status: DRAFT.
> Depends on: auth gate (locked), files jail (`safePath` reuse), database
> credential registry + config normalizer (locked, reused — no second copy).
> Gate: approve before backup routes are ported.

## 1. Objective

Port the Terwo backup manager (`terwo/panel.js:1255-1358`: `backups/`
metadata sidecars, folder zip, `mysqldump`/`pg_dump` dumps, download,
delete, folder-unzip + SQL-pipe restore) to typed Fastify handlers with
an injectable shell/fs seam, so backups work identically with zero real
archives or databases in tests.

Success: all five endpoint behaviors per table; metadata sidecars stay
`0600`; DB credentials are read from the shared `db.json` registry (no
forked parsing); destructive restore stays explicit and logged.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/backup.ts
export type BackupType = 'folder' | 'mysql' | 'postgres';
export interface BackupMeta { name: string; file: string; type: BackupType; source: string; created: number }
export interface BackupEntry extends BackupMeta { size: number; mtime: number }
export interface BackupSystem {
  exec(cmd: string, timeoutMs: number): Promise<string>; // shell (defaultExec compatible)
  hasBin(bin: string): Promise<boolean>;
  mkdirp(dir: string): void;
  listDir(dir: string): string[];
  readFile(path: string): string | null;
  writeFile(path: string, data: string): void;
  removeFile(path: string): void;   // missing file → no-op (delete parity)
  statFile(path: string): { size: number; mtime: number; isFile: boolean } | null;
  streamFile(path: string): NodeJS.ReadableStream;
}
export interface BackupOptions {
  dataDir: string;                  // meta + archives live in <dataDir>/backups
  root: string;                     // file-manager jail for folder sources/targets
  sys: BackupSystem;
  dbConfig: (engine: 'mysql' | 'postgres') => DbConfig; // shared database registry reader
  now?: () => number;
}
export function sanitizeBackupName(raw: unknown, fallback: () => string): string;
export function registerBackupRoutes(app: FastifyInstance, opts: BackupOptions): void;
```

### Endpoints (all behind the session gate)

| Method + path | Body | Rules | Success |
|---|---|---|---|
| `GET /api/backups` | — | skips unreadable sidecars / missing archives (best-effort, Terwo parity) | `{backups}` newest-first (`created` desc) |
| `POST /api/backups` | `{type, name?, source?}` | 1 MB JSON; type enum; name defaults `backup-<stamp>`, sanitized `[^a-zA-Z0-9._-]`→`_`, duplicate → 400; folder: jailed source must exist + `zip` bin, `zip -rq <dir>/<name>.zip .` cwd source (120 s); db: non-empty db name + dump bin, engine dump pipeline (120 s); meta sidecar `0600` | `{ok:true, name}` |
| `GET /api/backups/:name/download` | — | name charset + meta must exist, else 400 `Backup not found`; archive must be a file | octet-stream attachment stream |
| `DELETE /api/backups/:name` | — | same guard; missing archive tolerated | `{ok:true}` (removes archive + sidecar) |
| `POST /api/backups/:name/restore` | `{targetPath?}` (folder only) | 1 MB JSON; same guard; folder: jailed target (default meta source), `mkdirp`, `unzip -o` (120 s); db: engine restore pipeline from stored source db (120 s) | `{ok:true}` |

### Behavior

- Name charset for URL names: `^[A-Za-z0-9._-]+$` else `Backup not found` (note: the character class differs from the sanitize class — `..` and leading dots technically pass; Terwo parity, documented quirk, do not "fix").
- Stamp: `YYYYMMDD-HHMMSS` local time (`backupStamp` parity); default name `backup-<stamp>`.
- Folder dump: `zip -rq '<backups>/<name>.zip' .` with `cwd: <src>` (archive stores relative entries, Terwo parity); source recorded as jail-relative (`relOf`).
- MySQL dump: `mysqldump -h <host> -P <port> -u <user>[ --password=<pw>] <db> > <dest>` (password flag omitted when empty, Terwo parity); bin `mysqldump`.
- Postgres dump: `PGPASSWORD=<pw> pg_dump -h <host> -p <port> -U <user> -d <db> > <dest>`; bin `pg_dump`.
- Folder restore: `unzip -o <archive> -d <target>` after `mkdirp`; bin `unzip`.
- MySQL restore: `mysql -h … -P … -u …[ --password] <sourcedb> < <archive>`; bin `mysql`.
- Postgres restore: `PGPASSWORD=… psql -h … -p … -U … -d <sourcedb> < <archive>`; bin `psql`.
- All shell values single-quoted (`quoteSingle`); ports numeric (from normalized config, never raw body).
- Meta sidecar: `{name, file, type, source, created}` written `0600` after a successful dump only (failed dumps leave no sidecar — Terwo parity: write happens post-exec).
- Bin hints verbatim Terwo (`mysqldump not found. Install mysql via the Store menu.`, etc.); db-name-missing message translated (`Nama database wajib diisi` → `Database name is required`).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
apps/server/src/backup.ts        # sanitize/stamp/meta + route registration
apps/server/test/backup-routes.test.ts  # inject() + memory sys (no zip, no DB)
```

## 5. Code Style

```ts
// Good: credentials flow from the shared registry, never re-parsed.
const cfg = opts.dbConfig('mysql');
const pw = cfg.password === '' ? '' : ` --password=${quoteSingle(cfg.password)}`;
```

- `unknown` bodies narrowed per field; JSDoc on all exports (English); `120000` named `ARCHIVE_TIMEOUT_MS`.

## 6. Testing Strategy

- Framework: Vitest, Fastify `inject()`, memory `BackupSystem` (file map + recorded commands, scripted failures) + fake `dbConfig`.
- Cases: list skips corrupt sidecars + missing archives + newest-first order; create validation (bad type, duplicate name, missing source, missing db name, missing bins with verbatim hints); folder zip exact command + cwd + sidecar content/mode note; mysql/pg dump exact pipelines incl. empty-password omission; download headers + bytes + unknown name 400 + non-file 400; delete removes both + tolerates missing archive; restore folder exact command + mkdirp record + default-vs-explicit target; restore db pipelines; traversal in source/target rejected; gate 401 on one route.
- Coverage: all validation + bin-hint branches.

## 7. Boundaries

- Always: jail folder sources/targets; quote shell values; `0600` sidecars; stream downloads.
- Ask first: retention/pruning policy; encryption at rest; raising the 120 s timeout.
- Never: interpolate unquoted input into shell; read DB passwords from anywhere but the shared registry; leave sidecars for failed dumps.

## 8. Success Criteria

- [ ] All five behaviors per table with zero real archives/databases in tests.
- [ ] Live smoke (Linux): real folder zip → download → delete; real DB dump/restore against local MariaDB/Postgres.
- [ ] Needs on-device verification: Termux `zip`/`mysqldump` availability notes (ADR-003).

## 9. Open Questions

- None open for v1 port.

## 10. Decisions

- URL-name charset quirk (`..` passes) preserved deliberately; not a vulnerability (joins stay inside `backups/` + meta lookup gates existence).
- DB credentials reuse the database module's registry/normalizer (no fork).

## 11. Parity mapping (§9.2)

| Terwo (`panel.js:line`) | OLP | Mark |
|---|---|---|
| `BACKUP_DIR`, `backupStamp`, `backupMeta` `:1256-1264` | same layout/naming/sidecar shape | parity |
| `apiBackupList` `:1265` (skip-unreadable, newest-first) | `GET backups` same | parity |
| `apiBackupCreate` `:1279` (enum, sanitize, duplicate, zip/dump) | `POST backups` same | parity |
| dump pipelines `:1305-1311` (flags, redirect, 120 s) | same commands/cwd discipline | parity |
| sidecar write `:1313` (`0600`, post-success) | same | parity |
| `apiBackupDownload` `:1316` (guard, stream, disposition) | `GET download` same | parity |
| `apiBackupDelete` `:1329` (tolerant unlink) | `DELETE` same | parity |
| `apiBackupRestore` `:1336` (target default, pipelines) | `POST restore` same | parity |
| Routes `:1551-1557` | same paths/methods | parity |
| Messages `Nama database wajib diisi`, `File backup hilang` | `Database name is required`, `Backup file is missing` | deviation (English, §9.3) |
| `File backup hilang` only when stat non-file | same condition | parity |
