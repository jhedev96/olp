# SPEC — kill wave 2 (privileged process kill)

> Module ids: `sysinfo` (kill helper), `server` (route), `web` (row action).
> Owner: TBD. Status: DRAFT (wave direction locked 2026-10-12).
> Depends on: wave 1 (`spec-monitor-wave.md` — sampler, parsers, routes).
> Gate: approve before W2-02 (sysinfo code). Security review is part of
> the gate (CAND-004 demands it — reviewer reads this spec + the diff).

## 1. Objective

Let an authenticated admin terminate a runaway process from the monitor
proc table with a two-step confirm, under a deny-by-default authz rule.
Non-goals: panel self-restart (CAND-015, needs respawn design), service
control (CAND-005), bulk kill, scheduled kills.

Success: per-row Kill button → dialog → `POST
/api/monitor/processes/:pid/kill` → row gone on refresh; `main` never
gains a way to kill PID 1, the panel itself, or (as non-root) another
user's processes. CAND-004 closes.

## 2. API Contract (TypeScript)

```ts
// packages/sysinfo/src/kill.ts (new)
export type KillSignal = 'TERM' | 'KILL';
export interface KillDeps {
  /** Panel's own pid (production: `process.pid`). */
  selfPid: () => number;
  /** Panel's euid, null when unavailable (production: `process.getuid?.()`). */
  selfUid: () => number | null;
  /** Real uid of a target pid, null when unreadable (production: `/proc/<pid>/status` Uid). */
  targetUid: (pid: number) => number | null;
  /** Signal sender (production: `process.kill`). Throws ErrnoException-like `{ code?: string }`. */
  sendSignal: (pid: number, signal: KillSignal) => void;
}
export type KillVerdict =
  | { ok: true; pid: number; signal: KillSignal }
  | { ok: false; reason: 'bad-pid' | 'denied-self' | 'denied-init' | 'denied-owner' | 'gone' | 'denied-os' | 'failed'; detail?: string };
export function decideKill(deps: KillDeps, pid: number, signal: KillSignal): KillVerdict;

// apps/server/src/monitor.ts (extend)
/// POST /api/monitor/processes/:pid/kill { signal?: 'TERM' | 'KILL' (default 'TERM') }
// 200 { ok: true, pid, signal } | 400 { error } (bad pid/signal)
// 403 { error } (denied-*) | 404 { error } (gone) | 500 { error } (failed)
```

### Behavior (authz — deny by default, in order)

1. `pid` must be an integer ≥ 2 (`bad-pid`, else 400). PID 1 is
   unconditionally refused (`denied-init` → 403).
2. `pid === selfPid()` is refused (`denied-self` → 403). The panel
   cannot suicide via its own API (restart stays CAND-015's problem).
3. Non-root callers (`selfUid() !== 0`) may only signal processes whose
   real uid equals their own; unknown target uid → `denied-owner` →
   403. Root callers (`selfUid() === 0`) skip the owner check (beyond
   rules 1–2) — the panel already runs privileged; the API adds no new
   capability, only authenticated convenience.
4. `sendSignal` errors map by `code`: `ESRCH` → `gone` (404);
   `EPERM`/`EACCES` → `denied-os` (403); anything else → `failed`
   (500, detail = message, capped 200 chars).
5. Every decision (allow AND deny) is server-logged with pid/signal/
   verdict (audit trail; stdout like the boot log, no new infra).
6. Frontend keeps the two-step: row Kill → ConfirmDialog (names the
   pid + command) → POST → refresh list. The header Kill Task button
   keeps scrolling to the table (unchanged).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/sysinfo && npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/sysinfo && npm run test --workspace=@olp/server
Smoke: live kill of a spawned `sleep` (gone after), deny-self/deny-init live, 401 live
```

## 4. Project Structure

```text
packages/sysinfo/src/kill.ts            # decideKill (pure, injected)
packages/sysinfo/src/index.ts           # re-export
packages/sysinfo/test/kill.test.ts
apps/server/src/monitor.ts              # + POST route (wires process.* + status Uid)
apps/server/test/monitor-routes.test.ts # + cases (extends W1 file)
smoke/linux.mjs                         # + kill/deny/401 checks
apps/web/src/pages/monitor.tsx          # per-row Kill + dialog (W2-04)
```

## 5. Code Style

- No `process.*` inside sysinfo (deps only — same doctrine as §5 of
  spec-sysinfo); server `monitor.ts` is the only place touching
  `process.pid`/`getuid`/`kill` plus the `/proc` Uid reader.
- No `any`; English JSDoc; error strings English, user-facing,
  non-leaking (never print raw errno stacks to the client).

## 6. Testing Strategy

- sysinfo: matrix — bad pid (0/1/-3/1.5/NaN), self, init, owner
  allowed/denied/unknown × root/non-root, ESRCH/EPERM/EOTHER mapping,
  bad signal rejected by caller contract (route validates; helper
  takes the union type only).
- server inject: 200 TERM + KILL default, 400 (pid `abc`, signal
  `HUP`), 403 self (read own pid via the wired dep against the test
  process — deterministic), 403 init, 404 gone (kill TTL-passed pid?
  use `0x7fffffff`? no — spawn + reap? simplest: pid that never
  exists like 2^22 on the test box is flaky; instead stub deps via
  route-option injection), 401 unauth.
- Route deps injection: `registerMonitorRoutes` gains an optional
  `kill?: KillDeps` override (tests pass fakes; production omits).
  All verdict paths (self/init/owner/gone/denied-os/failed) are driven
  deterministically through fakes — no process spawning in unit tests.
- smoke (behavioral): the smoke server runs on the same box, so start
  a real `sleep 300` on the test box, kill it via the endpoint, assert
  `kill -0` fails after; live asserts deny-init (pid 1 → 403) and 401
  without cookie. No stray `sleep` left behind (kill -9 fallback +
  assert).
- Frontend: row Kill opens dialog naming pid+command; confirm POSTs
  `{signal:'TERM'}` and refreshes; cancel POSTs nothing.

## 7. Boundaries

- Always: deny-list checked before send; audit log every decision;
  session gate (inherited).
- Ask first: widening beyond TERM/KILL; lifting the init/self ban for
  any caller; bulk endpoint.
- Never: GET-with-side-effects (kill is POST only); client-chosen raw
  signal numbers; logging full command lines of other users' processes
  (log pid+verdict only — privacy).

## 8. Success Criteria

- [ ] sysinfo + server build green; unit + inject suites green.
- [ ] Smoke kill/deny/401 checks green live; no stray `sleep` left.
- [ ] Monitor row Kill wired with dialog; CAND-004 closed.
- [ ] No kill-shaped code outside `kill.ts` + the one route.

## 9. Open Questions

- Windows/macOS kill path: out of scope (Linux-only wave; helper
  returns `failed` where `process.kill` semantics differ — documented).
- Root panels (`getuid() === 0`): owner check skipped by design —
  acceptable because the API adds no privilege beyond the process.

## 10. Decisions (locked 2026-10-12, human)

- Wave 2 = kill only (CAND-004); restart (015), services (005) stay out.
- Deny-by-default authz (init/self/owner rules above); TERM default,
  KILL opt-in; no other signals.
- Per-row Kill + existing ConfirmDialog (no new UI primitive).

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Proc table restart/terminal icons | Kill button per row (restart icon stays out — needs supervisor design, CAND-015/020 family) |
| Kill Task header button | Unchanged (scrolls to table; kill itself lives on rows behind confirm) |
| `truncated` / pm2 sections | Untouched by this wave |
