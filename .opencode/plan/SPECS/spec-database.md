# SPEC — database

> Module id: `database` (part of `@olp/server`: MySQL + PostgreSQL manager).
> Owner: TBD. Status: DRAFT.
> Depends on: auth gate (locked). New runtime deps: `mysql2`, `pg` (both
> already required by Terwo; absent → honest 500 with install hint).
> Gate: approve before database routes are ported.

## 1. Objective

Port the Terwo database manager (`terwo/panel.js:508-714`: `db.json`
credential store, one live connection per engine, browse + ad-hoc SQL for
MySQL/MariaDB and PostgreSQL) to typed Fastify handlers backed by an
injectable driver seam, so the Database UI works unchanged with zero real
database in tests.

Success: all nine endpoint behaviors per table; pg-per-database short
connections preserved; identifier quoting safe on both engines; `test`
stays HTTP-200-shaped (deliberate Terwo quirk).

## 2. API Contract (TypeScript)

```ts
// apps/server/src/database.ts
export type DbEngine = 'mysql' | 'postgres';
export interface DbConfig { host: string; port: number; user: string; password: string; database: string }
export interface DbRow { [col: string]: unknown }
export interface DbResult { fields: string[]; rows: DbRow[]; affected: number | null }
export interface DbDriver {
  test(cfg: DbConfig): Promise<void>;                       // throws with driver message on failure
  connect(cfg: DbConfig): Promise<DbConn>;                  // live handle (closed by disconnect/test paths)
  query(conn: DbConn, sql: string, params?: unknown[]): Promise<DbResult>;
  listDatabases(conn: DbConn): Promise<string[]>;
  listTables(cfg: DbConfig, db: string): Promise<string[]>; // pg opens its own short connection (no USE)
  previewRows(cfg: DbConfig, db: string, table: string): Promise<DbResult>; // SELECT * LIMIT 50
  close(conn: DbConn): Promise<void>;
}
export type DbConn = { readonly engine: DbEngine; readonly handle: unknown };
export interface DbRegistry { load(): Partial<Record<DbEngine, DbConfig>>; save(cfgs: Partial<Record<DbEngine, DbConfig>>): void }
export interface DatabaseOptions { registry: DbRegistry; drivers: Record<DbEngine, DbDriver>; live: Map<DbEngine, DbConn> }
export function defaultDbConfig(engine: DbEngine): DbConfig;
export function normalizeConfig(engine: DbEngine, body: Record<string, unknown>): DbConfig;
export function safeCell(value: unknown): unknown; // Buffer→utf8, Date→ISO (Terwo safeRow parity)
export function quotePgIdent(name: string): string;
export function registerDatabaseRoutes(app: FastifyInstance, opts: DatabaseOptions): void;
```

### Endpoints (all behind the session gate; `:engine` ∈ `mysql|postgres`, else no match → 404)

| Method + path | Body / query | Rules | Success |
|---|---|---|---|
| `GET /api/db/:engine/config` | — | — | `{config, connected}` (stored over defaults) |
| `POST /api/db/:engine/config` | partial cfg | 1 MB JSON; normalized + persisted | `{ok:true}` |
| `POST /api/db/:test` | full cfg | 1 MB JSON; short-lived attempt (5 s) | **Always HTTP 200:** `{ok:true}` or `{ok:false, error}` (deliberate quirk) |
| `POST /api/db/:engine/connect` | full cfg | 1 MB JSON; normalize + persist + drop old conn + connect (8 s); failure → 400 `Connection failed: <msg>` | `{ok:true, databases}` |
| `POST /api/db/:engine/disconnect` | — | idempotent (no conn → still ok) | `{ok:true}` |
| `GET /api/db/:engine/databases` | — | 400 when not connected | `{databases}` |
| `GET /api/db/:engine/tables?db=` | db required | 400 when not connected / db missing | `{tables}` |
| `GET /api/db/:engine/rows?db=&table=` | db + table required, each ≤ 128 chars | 400 when not connected / missing / overlong | `{fields, rows}` (first 50) |
| `POST /api/db/:engine/query` | `{sql}` | 1 MB JSON; non-empty, ≤ 20000 chars; driver params `[]` | `{fields, rows, affected}` |

### Behavior

- Defaults (Terwo parity): mysql `{127.0.0.1, 3306, root, '', ''}`, postgres `{127.0.0.1, 5432, postgres, '', ''}`; normalization coerces host/user/password to string, port via `parseInt \|\| default`, database `''` when absent.
- Registry persists to `db.json` (mode `0600`) on config-save and connect.
- Live map holds at most one connection per engine; `connect` closes the previous first; `disconnect` closes + removes (double-disconnect still `{ok:true}`).
- MySQL identifiers use driver `?`/`??` placeholders; pg identifiers use `"`-doubling (`quotePgIdent`); **values from URL/query params never interpolate raw** — only через placeholders or quoted idents.
- pg `tables`/`rows` open a short-lived client to the target database and close it in `finally` (pg has no `USE`; Terwo `withPgDb` parity). MySQL reuses the live connection (`SELECT * FROM ??.?? LIMIT 50`).
- `safeCell`: `Buffer` → utf8 string, `Date` → ISO string, else passthrough ( Terwo `safeRow` parity, per cell).
- Missing driver modules (`mysql2`/`pg` not installed): every endpoint for that engine answers 500 `{error:'Database module not installed. Run: npm install'}` (Terwo `dbLib` parity — message kept verbatim, it matches the monorepo install).
- Errors other than `test` propagate to the app handler (400 `{error}`); `connect` prefixes `Connection failed: ` (Terwo parity).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
apps/server/src/database.ts        # config/registry/drivers/routes
apps/server/test/database-routes.test.ts  # inject() + fake drivers/registry (no real DB)
```

## 5. Code Style

```ts
// Good: engine dispatch by map lookup, drivers injected.
const driver = opts.drivers[engine];
await driver.test(normalizeConfig(engine, body));
```

- `unknown` bodies narrowed per field; JSDoc on all exports (English); `mysql2`/`pg` imports isolated in the production driver factory (lazy `require`, missing → the 500 above, never a boot crash).

## 6. Testing Strategy

- Framework: Vitest, Fastify `inject()`, fake `DbDriver`s per engine (scripted results, recorded SQL/params, simulated failures) + memory registry.
- Cases: config get defaults/merge/connected flag; save normalizes + persists; test ok + failure shape (HTTP 200 both); connect persists + drops previous (close called) + returns databases + failure prefix; disconnect idempotent; databases/tables/rows when idle → 400; missing/overlong names → 400; rows field/row shape + 50-row contract via fake; query empty/overlong → 400 + passthrough of fields/rows/affected; mysql placeholder usage vs pg ident quoting (assert recorded calls); missing-driver 500; gate 401 on one route.
- Coverage: all validation + both-engine dispatch branches.

## 7. Boundaries

- Always: parameterized or quoted identifiers; caps (128/20000) enforced before touching drivers; passwords never logged or echoed.
- Ask first: multi-connection pools; write-query guards (currently any SQL allowed — single-admin design, document); new engines.
- Never: string-concatenate user input into SQL; persist plaintext beyond `db.json` `0600`; leak driver stack traces (message only).

## 8. Success Criteria

- [ ] All nine behaviors per table with zero real databases in tests.
- [ ] Live smoke (Linux): real MariaDB + PostgreSQL connect, browse, 50-row preview, ad-hoc SELECT.
- [ ] Needs on-device verification: Termux MariaDB/PostgreSQL bootstrap notes (README follow-up, ADR-003).

## 9. Open Questions

- `mysql2`/`pg` as direct `dependencies` vs `optionalDependencies` (Terwo: hard deps in `dependencies`, optionals only for `node-pty`). Proposal: hard deps (Database menu is core) — decided at implementation with lockfile evidence.
- SQL write-guard toggle — deferred (single-admin parity, documented above).

## 10. Decisions

- `test` stays HTTP-200-shaped (quirk preserved deliberately for UI compat).
