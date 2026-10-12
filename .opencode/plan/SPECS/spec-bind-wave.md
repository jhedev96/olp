# SPEC — editable bind + restart wave 13 (restart-capable config)

> Modules: `server` (`settings.ts` schema + endpoints, `index.ts`
> boot/resolve/restart wiring) + `web` (settings bind card). No new
> dep. Owner: TBD. Status: DRAFT (locked 2026-10-12, human Q&A).
> Depends on: read-only bind card (wave 9), reload docs card.
> Gate: approve before W13-01 (first code).

## 1. Objective

Close CAND-037: persist host/port from the UI (env keeps
precedence), validate honestly, restart via an explicit endpoint
with supervisor-aware UI, and recover from bad binds by falling
back to localhost with a loud log — never a dead panel, never a
silent bind change.

Success: saving `127.0.0.1:9090` persists + flags restart-required;
restart returns ok then the process exits for its supervisor;
a taken port falls back to `127.0.0.1:8080` with a loud log and a
UI mismatch warning; smoke proves save + restart-exit live.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/settings.ts
export interface BindFile { host: string; port: number }
export interface Settings { telegram: TelegramSettings; bind: BindFile | null } // null = unset
export interface BindReport { configured: BindConfig; source: 'env' | 'file' | 'default'; effective: BindConfig; fallback: boolean }
export interface BindConfig { host: string; port: number }
export function validateBind(host: unknown, port: unknown): { ok: true; bind: BindConfig } | { ok: false; error: string };
export function resolveBind(env: { PANEL_HOST?: string; PANEL_PORT?: string }, file: BindFile | null): { bind: BindConfig; source: 'env' | 'file' | 'default' };
// POST /api/settings/bind { host, port } -> { ok: true, restartRequired: true } (400 names the problem; never applies live)
// GET /api/settings bind: { host, port, loopback, source, effectiveHost, effectivePort, fallback }
// POST /api/server/restart -> { ok: true, supervisor: 'pm2' | 'unknown' } (then graceful close + exit 0)
```

### Behavior

- Precedence (locked): valid env pair wins; else valid file;
  else `{127.0.0.1, 8080}`. Invalid env values are IGNORED (fall
  through + console warning — never crash boot on a typo).
- Validation: host matches `/^[a-zA-Z0-9.:\[\]-]{1,253}$/`
  (format-only; DNS resolves at listen, failure → fallback);
  port integer `1024–65535` (`<1024` denied: privileged ports +
  inventory 1024+ rule, message says so).
- `resolveBind` is pure (env + file in, decision out) — the
  precedence matrix is unit-tested, not boot-tested.
- Boot (`main`): resolve → `listenWithFallback(app, primary,
  {127.0.0.1, 8080})` → on primary `EADDRINUSE`/`EACCES`: loud
  `console.error` + listen fallback (`fallback: true`, effective
  updated in the shared holder). Fallback failing → exit 1
  (nothing left to serve; supervisor will loop — documented).
- Report holder: `main` creates `{configured, source, effective,
  fallback}`, passes BY REF into settings opts; listen updates
  `.effective/.fallback`. Tests inject their own holder.
- Restart: respond `{ok, supervisor}` FIRST, then
  `setImmediate(close + exit(0))`. Exit code 0 (supervisor
  restarts; manual runners were warned). `exit` injectable
  (`opts.serverExit`, default `process.exit` — tests never kill
  the runner). Supervisor = `pm_id ∈ env ? 'pm2' : 'unknown'`
  (best-effort, documented).
- Sessions die on restart (in-memory, by design): UI polls
  `/api/health` (2 s × 15) then `goto('/login')` — never pretends
  the session survives. Timeout → "restart manually" + copy
  command (existing RELOAD_CMD).
- Bind card: when `source === 'env'`, inputs DISABLED with an
  honest note (unset `PANEL_HOST/PORT` to use the file); else
  editable + Save + restart-required note + Restart button
  (confirm dialog: supervisor/downtime copy) + configured≠
  effective mismatch warning.
- Save never applies live (listener can't move without restart
  — the response says `restartRequired: true`, never silent).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
Smoke: live save bind (file source) -> invalid shapes 400 -> restart ok + process exits (LAST check, then summary)
```

## 4. Project Structure

```text
apps/server/src/settings.ts                  # schema/bind/resolve/validate/endpoints + report holder type
apps/server/src/index.ts                     # main resolve + listenWithFallback + restart wiring + exit seam
apps/server/test/settings-telegram.test.ts   # + matrix/cases (extends file)
smoke/linux.mjs                              # + bind/restart checks (restart LAST)
apps/web/src/pages/settings.tsx              # bind card editor (W13-05)
apps/web/test/settings.test.tsx              # + cases
```

## 5. Code Style

- Pure resolve/validate (no `process.env` inside — callers pass
  values; tests stay env-free except one save/restore case).
- No `any`; English JSDoc; caps (`1024/65535`, 2 s × 15 poll,
  holder mutated only by listen/restart paths).

## 6. Testing Strategy

- Pure matrix: precedence (env-valid/file-valid/default +
  invalid-env falls through + invalid-file falls through);
  validation (good/host-bad/port-low/port-fractional/port-huge/
  empty); report-holder mutation by (fake) listen outcomes.
- Inject: save persists + flags restartRequired + never changes
  the listening socket (GET bind unchanged effective);
  invalid shapes 400 with naming messages; env-source note
  (set `PANEL_*`? — env mutation save/restore, one case);
  restart responds ok WITHOUT exiting (fake exit asserted
  called with 0 + close called); unknown-id… n/a.
- `listenWithFallback`: real Fastify on an occupied port (net
  server squats it) → fallback taken; free port → primary.
- Smoke (behavioral, restart LAST): save file bind → source
  file + restartRequired → invalid 400s → restart ok →
  health unreachable ≤10 s → summary prints (client-side only
  after death — no more requests).
- Frontend: env-source disables + note; save posts + note;
  restart dialog copy per supervisor; poll-then-login;
  mismatch warning; CAND-037 never existed as ComingSoon
  (bind card existed — extend, no dummy to drop).

## 7. Boundaries

- Always: session gate on save + restart (same trust as
  logout-all); confirm dialog before restart; fallback keeps
  the panel reachable; loud logs on every fallback/exit.
- Ask first: widening host validation (CIDR? unix sockets?);
  auto-restart on save; systemd unit generation.
- Never: apply bind live; exit non-zero on restart (would
  alarm supervisors); trust client-supplied effective values;
  refuse-start on a bad file bind (fallback, locked §10).

## 8. Success Criteria

- [ ] Server build green; inject suite green.
- [ ] Smoke bind/restart checks green live (restart exits,
  summary still prints).
- [ ] Settings bind editor wired; CAND-037 closed.
- [ ] Existing behavior diff-empty except additive `bind`
  fields, `POST bind`, `POST restart` (default boot path
  byte-identical: env/defaults resolve as before).

## 9. Open Questions

- CAND-015's panel self-restart half: implemented here; 015
  keeps its site-stats half (stays open, noted in W13-06).
- systemd unit generation / PM2 ecosystem writes: out
  (installers own supervisor setup).

## 10. Decisions (locked 2026-10-12, human Q&A)

- Precedence env > file > default (installers/PM2 keep working).
- Bad bind → loud log + localhost fallback (never a dead panel).
- Restart = respond-ok then self-exit for the supervisor
  (manual runners warned; UI polls then goes to login).

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| PANEL_HOST/PORT display | bind card (configured + effective + source) |
| Lock-to-localhost toggle | OUT — env/file edit covers it (toggle would hide precedence; documented) |
| Reload via terminal docs | existing card (linked from bind card + restart timeout) |
| Reset-to-factory card | OUT (unchanged — not in CAND-037 text) |
