# SPEC — database wave 4 (create + schema info)

> Module ids: `server` (`database.ts` drivers + routes only — no new
> package). Owner: TBD. Status: DRAFT (wave direction locked 2026-10-12).
> Depends on: existing `DbDriver` short-lived-conn pattern.
> Gate: approve before W4-02 (driver code).

## 1. Objective

Close CAND-006 (Create New Database) and CAND-026 (schema DDL view +
table sizes/row counts + data-vs-index panel) with dedicated endpoints
— NOT client-composed SQL (identifiers can't be parameterized; table
names from the client must never be string-interpolated without quoting).

Success: New Database button creates on both engines with validated
names; schema browser shows per-table rows/size; per-table Schema
button shows exact DDL (mysql) or exact columns (pg); data-vs-index
panel computes from the same rows. No live-DB gate exists in the agent
box (no engines here) — see §6 for the honesty plan.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/database.ts (driver interface additions)
export interface TableStat { name: string; rows: number | null; dataBytes: number | null; indexBytes: number | null }
export interface TableDef { ddl: string | null; columns: Array<{ name: string; type: string; nullable: boolean; def: string | null }> | null }
export interface DbDriver {
  /* ...existing... */
  createDatabase(cfg: DbConfig, name: string): Promise<void>;
  tableStats(cfg: DbConfig, db: string): Promise<TableStat[]>;
  tableDef(cfg: DbConfig, db: string, table: string): Promise<TableDef>;
}
// POST /api/db/:engine/databases { name } -> { ok: true, databases }
//   400 invalid name | 409 exists | 403 privilege-denied | 500 other
// GET /api/db/:engine/schema?db= -> { tables: TableStat[] }
// GET /api/db/:engine/ddl?db=&table= -> TableDef
// (existing 400-on-throw convention kept for schema/ddl; create uses
// 409/403/500 — deviation recorded below)
```

### Behavior

- Name validation (create): `^[A-Za-z0-9_$]+$`, 1–64 chars, else 400
  `Invalid database name (letters, digits, _ and $, max 64)`. Same
  128-char cap convention as `/rows` applies to schema/ddl inputs.
- mysql driver (short-lived conn, established pattern):
  `CREATE DATABASE ??` (identifier escaping, [name]); errors:
  `ER_DB_CREATE_EXISTS` (1007) → 409, access-denied (1044/1045) → 403,
  else 500 with message. Returns fresh `listDatabases`.
- pg driver: `open(cfg, 'postgres')` maintenance conn,
  `CREATE DATABASE "quoted"` (`quotePgIdent`, exists); code `42P04`
  → 409, `42501` → 403, else 500. Returns fresh list.
- mysql stats (one parameterized query, exact lengths, approximate
  rows — InnoDB `table_rows` is an estimate, documented in JSDoc):
  `SELECT table_name, table_rows, data_length, index_length FROM
  information_schema.tables WHERE table_schema = ?`.
- pg stats (reltuples approximate — documented; sizes exact):
  `SELECT relname, reltuples::bigint, pg_relation_size(oid),
  pg_indexes_size(oid) FROM pg_class WHERE relkind='r' AND
  relnamespace NOT IN ('pg_catalog'::regnamespace,
  'information_schema'::regnamespace)`.
- mysql def: `SHOW CREATE TABLE ??.??` → `{ ddl: text, columns }`
  (columns from `information_schema.columns`, exact).
- pg def: `{ ddl: null, columns }` from `information_schema.columns`
  (`column_name, data_type, is_nullable, column_default`) — no
  fabricated `CREATE TABLE` text (generating correct PG DDL is a
  project of its own; columns are exact, ddl honestly null).
- Data-vs-index panel: client sums `dataBytes`/`indexBytes` (nulls
  treated as unknown, footnoted when any row lacks sizes).
- Frontend: New Database button + name dialog → POST → refresh list +
  message; tables list gains rows/size badges; per-table Schema button
  → DDL modal (ddl text or column table); ComingSoon CAND-026 drops.
- Auth: session gate (inherited). Body caps per existing routes.

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
Smoke: none possible (no engines in agent/CI box — recorded manual gate, see §6)
```

## 4. Project Structure

```text
apps/server/src/database.ts            # +3 driver methods ×2 engines +3 routes
apps/server/test/database-routes.test.ts # + fake-driver cases (extends file)
apps/web/src/pages/database.tsx        # New Database dialog, badges, DDL modal, panel
apps/web/test/database.test.tsx        # + cases
```

## 5. Code Style

- Short-lived conns per call (never the live map for DDL/stats —
  matches `listTables`/`previewRows` precedent); `finally` close.
- Identifiers: mysql `??` / pg `quotePgIdent` — never raw
  interpolation (the one rule of this wave).
- No `any`; English JSDoc with approximation notes where exactness
  is engine-limited (InnoDB rows, reltuples).

## 6. Testing Strategy

- routes: fake drivers (established pattern in
  `database-routes.test.ts`) — validation 400s, exists 409, denied
  403, other 500, shapes for schema/ddl incl. null-ddl pg path,
  unknown engine untouched, existing 9-endpoint suite green.
- drivers: NO live-DB tests in this repo (no engines in the agent
  box, none in CI). Verification = fake-driver route coverage + SQL
  review against engine docs + recorded HUMAN gate: run New
  Database + schema browser against real MariaDB/Postgres before
  release (same gate class as Termux on-device proofs).
- frontend: dialog validation + POST + refresh, badges render,
  DDL modal both shapes, panel sums with null footnote.
- smoke: unchanged (no engines to prove against; smoke stays honest
  rather than theatrical).

## 7. Boundaries

- Always: validated/escaped identifiers; session gate; short-lived conns.
- Ask first: DROP DATABASE (not requested — never sneak it in);
  cross-db queries; raising the 128-char cap.
- Never: client-built DDL/schema SQL through `/query` for these
  features (that's the injection hole this wave exists to avoid);
  fake live-DB proof.

## 8. Success Criteria

- [ ] Server build green; inject suite green (fake drivers).
- [ ] Web build + suite green; ComingSoon CAND-026 gone, New
  Database live in UI.
- [ ] CAND-006 + CAND-026 closed; manual live-DB gate recorded in
  TODOS and executed by human before release.
- [ ] Existing 9-endpoint behavior diff-empty.

## 9. Open Questions

- Import/export (CAND-025) reuses dump binaries — separate wave,
  needs file-transfer design. Not here.
- 64-char cap vs pg's 63: pg edge errors honestly at 64 — accepted,
  documented.

## 10. Decisions (locked 2026-10-12, human)

- Wave 4 = create + schema info (006+026); import/export (025) and
  Redis (024) stay out.
- Dedicated endpoints over client-composed SQL (injection rationale).
- No fake live-DB gate: fake-driver coverage + review + human gate.

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| New Database button | POST databases → refresh + message |
| Per-table row counts + sizes | GET schema (approximate rows footnoted) |
| Schema/browse/download per table | DDL modal (ddl or columns); browse exists; download stays out (025) |
| Data-vs-index panel | Client sums + null footnote |
