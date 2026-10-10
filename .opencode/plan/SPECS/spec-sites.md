# SPEC — sites

> Module id: `sites` (part of `@olp/server`: registry + process manager + routes).
> Owner: TBD. Status: DRAFT.
> Depends on: auth gate (locked), files jail semantics (locked: `safePath` reuse).
> Gate: approve before website-hosting routes are ported.

## 1. Objective

Port Terwo mini-hosting (`terwo/panel.js:295-434`: `sites.json` registry plus Node/PHP/static/Go runners with start/stop/restart/logs) to typed Fastify handlers backed by an injectable process manager, so websites run identically on OLP with per-OS runtime resolution ready (via `env-core` later, Termux + Linux first).

Success: all five site endpoints behave per table; logs stream into a 300-line ring with dead-log retention; `PORT` injection works for Node/Go; no `child_process` in route code.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/sites.ts
export type SiteType = 'node' | 'php' | 'static' | 'go';
export interface Site { id: string; name: string; type: SiteType; path: string; port: number; created: number }
export interface SiteStatus extends Site { running: boolean }
export interface SiteProcess { kill(): void; onOutput(cb: (chunk: string) => void): void; onExit(cb: (code: number | null) => void): void; onError(cb: (err: Error) => void): void }
export interface SiteSpawner {
  spawn(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): SiteProcess;
  hasBin(bin: string): Promise<boolean>; // `command -v` probe (tests inject fakes)
}
export interface SiteStore { list(): Site[]; save(sites: Site[]): void } // JSON file in production, memory in tests
export interface SitesOptions { root: string; store: SiteStore; spawner: SiteSpawner }
export function registerSitesRoutes(app: FastifyInstance, opts: SitesOptions): void;
```

### Endpoints (all behind the session gate)

| Method + path | Body | Limits / rules | Success |
|---|---|---|---|
| `GET /api/sites` | — | — | `{sites: SiteStatus[]}` (`running` per id) |
| `POST /api/sites` | `{name, type, path, port}` | 1 MB JSON; name required; type enum; port 1024–65535 + collision guard; path must exist (file for `node`, dir otherwise, all inside jail) | `{ok:true, site}` (`id` 16 hex chars) |
| `POST /api/sites/:id/start` | — | 404 unknown id; 400 already running; runtime bin checks (`python3` for static, `go` for Go) | `{ok:true}` |
| `POST /api/sites/:id/stop` | — | 400 when not running | `{ok:true}` |
| `POST /api/sites/:id/restart` | — | stop-if-running (500 ms grace) then start | `{ok:true}` |
| `POST /api/sites/:id/delete` | — | kills if running, removes registry + dead logs | `{ok:true}` |
| `GET /api/sites/:id/logs` | — | 404 unknown id | `{logs, running}` (live ring or retained dead log) |

### Behavior

- Route shape preserved exactly: `/api/sites/:16hex/:action` (`terwo/panel.js:1491`), unknown ids → 404 `{error:'Website not found'}` (Terwo throws → outer 400; OLP normalizes missing resources to 404 — deliberate, documented deviation; validation failures stay 400).
- Runners (Terwo parity `panel.js:365-382`, `PORT` injected):
  - `node`: `node <file>`, `cwd` = file dirname, `PORT=<port>`.
  - `php`: `php -S 127.0.0.1:<port> -t <dir>`, `cwd` = dir.
  - `static`: `python3 -m http.server <port> --directory <dir>`, `cwd` = dir (bin gate with Store hint).
  - `go`: `go run .`, `cwd` = project dir, `PORT=<port>` (bin gate with Store hint).
- Start banner pushed first: `--- start (<type>) port <port> ---\n`; stdout+stderr appended; ring-trimmed to 300 entries.
- Exit/error: push end banner (`--- stopped (exit <code>) ---` / `--- failed to start: <msg> ---`, English; legacy Indonesian translated), retain joined dead log, drop from running map.
- `stop` kills (fire-and-forget, Terwo parity — no graceful wait); `delete` also kills first.
- Registry persists to `sites.json` (mode `0600`, same data dir as auth config) on create/delete; running state is memory-only (restarts clear it, Terwo parity).
- `path` stored rel-style (`relOf` jail root) and resolved via `safePath` on use (reuses files jail — no second implementation).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
apps/server/src/sites.ts        # registry helpers, manager, route registration
apps/server/test/sites-routes.test.ts  # inject() + fake spawner/store (no real processes)
```

## 5. Code Style

```ts
// Good: spawner injected, no child_process import in routes.
const proc = opts.spawner.spawn('node', [file], { cwd: dirname(file), env: { ...process.env, PORT: String(site.port) } });
```

- `unknown` bodies narrowed per field; JSDoc on all exports (English); `node:child_process` only inside the production spawner factory.

## 6. Testing Strategy

- Framework: Vitest, Fastify `inject()`, fake `SiteSpawner` (scripted output/exit, records commands/env/cwd) + memory `SiteStore`, tempdirs for path validation.
- Cases: create validation matrix (missing name, bad type, bad port range, port collision, missing path, node-dir/php-file mismatches); list `running` flags; start command shape per type incl. `PORT` env + cwd; double-start 400; stop-when-idle 400; restart kills then starts; delete removes + kills; logs live ring content + trim at 300 + dead-log retention after exit + unknown-id 404; gate 401 on one route.
- Coverage: all validation branches + exit/error paths.

## 7. Boundaries

- Always: jail paths via files `safePath`; kill on delete; never expose env secrets in logs.
- Ask first: adding a runtime (e.g. python-wsgi, ruby); changing the `:id/:action` URL shape; persisting running state.
- Never: shell-interpolate paths (argv arrays only); run as root-privileged ports (<1024 rejected); block the event loop on process I/O.

## 8. Success Criteria

- [ ] All seven route behaviors per table with zero real processes in tests.
- [ ] Live smoke on Linux: real Node static site starts, serves on its port, logs stream, restart + delete clean up.
- [ ] No Indonesian strings; no `process.platform` branches (bin names constant across P0/P1; per-OS install hints come from `pkgman` later).

## 9. Open Questions

- Health-check + Telegram down/recover notifications (`panel.js:1391-1406`) — separate spec (`spec-watchdog.md`) or part of sites? Proposal: separate, after telegram spec.
- `sites.json` file locking for concurrent writes — single-admin low risk; document as accepted (parity).

## 10. Decisions

- None yet.
