# SPEC — daemon status wave 3 (Services & Daemons)

> Module ids: `sysinfo` (presence scan), `services` (reuse controller),
> `server` (new `services.ts` routes). Owner: TBD. Status: DRAFT
> (wave direction locked 2026-10-12). Depends on: `env-core`
> (manager id), `spec-services.md` (controller contract), wave 1
> (endpoint patterns). Gate: approve before W3-02.

## 1. Objective

Serve real daemon status (+ best-effort start) for the dashboard
Services & Daemons section: mariadb, postgres, redis, cronie with
ACTIVE badges and START buttons. Status comes from process presence
(Terwo `pgrep` parity — the `services` package's own doctrine), never
from guessed unit names; control reuses `serviceController` and
surfaces its honest errors. CAND-005 closes; restart/stop-everywhere
stay out.

Success: dashboard section renders 4 live cards; stopped daemons offer
START that either flips them ACTIVE or shows the backend's real error.
No invented states on any env.

## 2. API Contract (TypeScript)

```ts
// packages/sysinfo/src/daemons.ts (new)
export interface DaemonDef { id: 'mariadb' | 'postgres' | 'redis' | 'cronie'; comms: string[] }
export const DAEMONS: DaemonDef[] = [
  { id: 'mariadb', comms: ['mysqld', 'mariadbd'] },
  { id: 'postgres', comms: ['postgres'] },
  { id: 'redis', comms: ['redis-server'] },
  { id: 'cronie', comms: ['crond', 'cron'] },
];
export function scanDaemons(deps: Pick<SysDeps, 'readDir' | 'readFile'>): Record<string, boolean>;
// presence = any /proc/<pid>/comm (else Name:) matches a comm exactly.

// apps/server/src/services.ts (new)
export interface DaemonStatus { id: string; name: string; port: number | null; active: boolean }
/// GET /api/services -> { services: DaemonStatus[] }
/// POST /api/services/:id/start -> { ok: true } | { error } (controller message, capped)
// Static labels/ports live in the route (presentation facts, not probes):
// mariadb MariaDB 3306, postgres PostgreSQL 5432, redis Redis 6379, cronie Cronie null.
```

### Behavior

- Status: `scanDaemons` reads `/proc` pid dirs (cap 512, raced exits
  skipped), matching `/proc/<pid>/comm` trimmed else `status` Name
  against each daemon's comm list (exact match). Any failure of the
  whole scan → all `false` (never throw, never guess).
- Unit names for control (best-effort, conventional only):
  `{ mariadb: 'mariadb', postgres: 'postgresql', redis: 'redis-server',
  cronie: 'cron' }`. Distros vary (Arch `redis`, Fedora `crond`) — the
  controller's `Failed to start X: …` message is the honest signal and
  surfaces verbatim (capped 300 chars) in the UI error line.
- Manager from `env.service`; `none` → start answers 500 `No
  supported init system` (actionable, never silent).
- Unknown `:id` → 404. Session gate applies (401 live-asserted).
- Frontend: ACTIVE badge (success tone) or START button per card;
  START → POST → refresh section; error line on failure. No STOP
  button (mockup shows START only — recorded).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/sysinfo && npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/sysinfo && npm run test --workspace=@olp/server
Smoke: live status shape on Linux + deny-shape 401 + start-error honesty (stopped daemon or unknown manager path)
```

## 4. Project Structure

```text
packages/sysinfo/src/daemons.ts
packages/sysinfo/src/index.ts        # re-export
packages/sysinfo/test/daemons.test.ts
apps/server/src/services.ts          # routes (name differs from package on purpose: domain routes)
apps/server/test/services-routes.test.ts
smoke/linux.mjs                      # + services checks
apps/web/src/pages/dashboard.tsx     # section wiring (W3-04)
```

## 5. Code Style

- sysinfo stays `process`-free (deps only); server owns `env.service`
  mapping + controller construction.
- No `any`; English JSDoc; user-facing errors English, capped.

## 6. Testing Strategy

- sysinfo: comm match, Name fallback, no-match, raced-exit throw,
  readDir throw → all-false, 512 cap.
- server inject: shape + labels/ports, unknown id 404, start ok path
  (injected controller fake), start error passthrough (capped),
  `none`-manager 500, 401 both routes, stats/monitor suites untouched.
- Controller construction seam: route builds via injectable
  `controllerOf?: (manager) => ServiceController` override (tests pass
  fakes; production uses `serviceController` + `defaultExec`-ish exec).
  Production exec: reuse `sysDeps.exec` (same runner as the rest).
- smoke (behavioral): live shape (4 entries, boolean actives),
  start on already-meaningless unit returns honest error (assert
  `{error}` string, not ok), 401 without cookie.
- frontend: ACTIVE badge renders from stub; START posts + refreshes;
  error line shows controller message.

## 7. Boundaries

- Always: presence-first status; surfaced (never swallowed) control errors.
- Ask first: per-distro unit-name tables; STOP buttons; auto-start daemons.
- Never: auto-starting anything as a side effect of status reads;
  shell out except via injected `exec`; guessing ACTIVE.

## 8. Success Criteria

- [ ] sysinfo + server build green; unit + inject suites green.
- [ ] Smoke services checks green live.
- [ ] Dashboard section wired; CAND-005 closed.
- [ ] No other route's payload changed.

## 9. Open Questions

- Launchd unit labels (homebrew domains): unresolved — best-effort
  attempt stands, macOS owner verifies on-device.
- PM2-managed user daemons (`pm2 describe <name>` hits): accepted
  miss — presence still reports them ACTIVE correctly.

## 10. Decisions (locked 2026-10-12, human)

- Wave 3 = daemon status + START (CAND-005); STOP-all/restart/services-control-out stay out.
- Presence (not unit names) is the status source of truth.
- Control is best-effort with verbatim surfaced errors (no fake ACTIVE).

## 11. Parity mapping (mockup → endpoint)

| Mockup card | Source after wave |
|---|---|
| MariaDB ACTIVE / port | presence(mysqld) + static 3306 |
| PostgreSQL START / port | presence(postgres) + static 5432 + START button |
| Redis ACTIVE / port | presence(redis-server) + static 6379 |
| Cronie ACTIVE / version | presence(crond) (version string stays out — no source) |
| START buttons | POST start → refresh or honest error line |
