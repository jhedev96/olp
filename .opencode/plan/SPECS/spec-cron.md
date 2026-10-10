# SPEC — cron

> Module id: `cron` (part of `@olp/server`: crontab scheduler GUI + routes).
> Owner: TBD. Status: DRAFT.
> Depends on: auth gate (locked), shared `exec` (locked).
> Gate: approve before cron routes are ported. First spec using the §9.2
> parity-mapping format (see §11).

## 1. Objective

Port the Terwo cron scheduler (`terwo/panel.js:1168-1254`: `panel:`-tagged
crontab lines, enable/disable via `#` comments, `crond` service control) to
typed Fastify handlers with an injectable crontab backend, so scheduled
commands work identically with zero real cron in tests.

Success: all six endpoint behaviors per table; foreign (untagged) crontab
lines pass through untouched; the tag codec round-trips exactly.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/cron.ts
export interface CronJob { id: string; name: string; schedule: string; command: string; enabled: boolean }
export interface CronBackend {
  readLines(): Promise<string[]>;          // `crontab -l` (missing/empty → [])
  writeLines(lines: string[]): Promise<void>; // `crontab -` via stdin (rejects with tail on failure)
  exec(cmd: string, timeoutMs: number): Promise<string>; // probes + pkill
  spawnDetached(cmd: string, args: string[]): void;      // `crond` start (fire-and-forget)
  hasBin(bin: string): Promise<boolean>;
}
export interface CronOptions { backend: CronBackend }
export function parseCronLine(line: string): CronJob | null;
export function cronJobLine(job: Pick<CronJob, 'schedule' | 'command' | 'id' | 'name'>): string;
export function toggleCronLine(line: string, id: string): string; // pure per-line toggle (no-op unless tagged id matches)
export function registerCronRoutes(app: FastifyInstance, opts: CronOptions): void;
```

### Endpoints (all behind the session gate)

| Method + path | Body | Rules | Success |
|---|---|---|---|
| `GET /api/cron/status` | — | `pgrep -x crond` probe | `{running}` |
| `POST /api/cron/service` | `{action: 'start'\|'stop'}` | 1 MB JSON; `start` requires `crond` bin (Cronie Store hint), spawns detached + unrefed; `stop` = `pkill -x crond` (result ignored); unknown action 400 | `{ok:true}` |
| `GET /api/cron/jobs` | — | parses all lines, keeps tagged only | `{jobs}` |
| `POST /api/cron/jobs` | `{name, schedule, command}` | 1 MB JSON; name defaults `'job'`; schedule must match 5-field `^(\S+\s+){4}\S+$`; command required; requires `crontab` bin; appends + writes | `{ok:true, job}` (`id` 8 hex chars) |
| `POST /api/cron/jobs/:id/toggle` | — | unknown id still rewrites (no-op write, `{ok:true}` — Terwo parity, no 404) | `{ok:true}` |
| `DELETE /api/cron/jobs/:id` | — | drops tagged lines with id, keeps everything else (incl. foreign lines) | `{ok:true}` |

### Behavior

- Tag codec (byte-exact Terwo parity): line = `<schedule> <command> # panel:<hexid>:<name>`; name sanitized `[\r\n#]` → space; parse strips one leading `#` (with optional leading whitespace) for `enabled:false`, requires `#\s*panel:<hex>:<name>$`, requires ≥6 head tokens (5 schedule + ≥1 command).
- Toggle: enabled tagged line → prefix `#`; disabled → remove first `#` (whitespace-preserving `^(\s*)#` → `$1`); non-matching lines byte-identical.
- Write path joins with `\n` + trailing newline via stdin to `crontab -`; failure rejects `crontab failed: <stderr-tail-300>`.
- Read path tolerates absent crontabs (probe failure → `[]`, Terwo `cronLines` parity).
- Service `stop` ignores `pkill` results (idempotent, Terwo parity).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
apps/server/src/cron.ts        # codec, backend-driven manager, route registration
apps/server/test/cron-routes.test.ts  # inject() + memory backend (no real cron)
```

## 5. Code Style

```ts
// Good: codec pure, backend injected, no child_process import in routes.
const jobs: CronJob[] = [];
for (const line of await opts.backend.readLines()) {
  const job = parseCronLine(line);
  if (job !== null) jobs.push(job);
}
```

- `unknown` bodies narrowed per field; JSDoc on all exports (English).

## 6. Testing Strategy

- Framework: Vitest, Fastify `inject()`, memory `CronBackend` (line array + recorded execs/spawns, scripted failures).
- Cases: codec matrix (tagged/disabled/foreign/malformed/short/name-sanitize/round-trip); jobs filters foreign; add validation (schedule regex, missing command, missing `crontab` bin message); add appends exact line; delete keeps foreign + drops id; toggle both directions + unknown-id no-op write; status true/false; service start records detached spawn + missing-bin hint; stop records pkill; unknown action 400; gate 401 on one route.
- Coverage: all codec + validation branches.

## 7. Boundaries

- Always: preserve foreign lines byte-for-byte on every write; sanitize names; cap bodies 1 MB.
- Ask first: per-OS scheduler backends (systemd timers, launchd — beyond crontab); secret redaction in commands.
- Never: drop untagged lines; shell-interpolate job content (stdin only, never `bash -c`); run `crond` attached.

## 8. Success Criteria

- [ ] All six behaviors per table with zero real cron in tests.
- [ ] Live smoke (Linux): real `crontab` round-trip add/toggle/delete, foreign line preserved.
- [ ] Needs on-device verification: Termux `cronie`/`crond` boot behavior (ADR-003).

## 9. Open Questions

- None open for v1 port.

## 10. Decisions

- Unknown-id toggle/delete stay no-op-write `{ok:true}` (Terwo parity, deliberate).

## 11. Parity mapping (§9.2)

| Terwo (`panel.js:line`) | OLP | Mark |
|---|---|---|
| `cronSpawnWrite` `:1169` (bash `crontab -`, tail-300) | `CronBackend.writeLines` same semantics | parity |
| `cronLines` `:1180` (failure → `[]`) | `readLines` same | parity |
| `cronParseLine` `:1185` (tag regex, 6-token rule) | `parseCronLine` same | parity |
| `cronJobLine` `:1197` (name sanitize) | `cronJobLine` same | parity |
| `apiCronStatus` `:1200` (`pgrep -x crond`) | `GET status` same | parity |
| `apiCronService` `:1204` (detached spawn, `pkill`, bin hint) | `POST service` same | parity |
| `apiCronJobs` `:1216` (tagged only) | `GET jobs` same | parity |
| `apiCronAdd` `:1224` (regex, default name `job`, bin gate) | `POST jobs` same | parity |
| `apiCronDelete` `:1238` (keep foreign) | `DELETE jobs/:id` same | parity |
| `apiCronToggle` `:1244` (`#` prefix rule) | `POST jobs/:id/toggle` same | parity |
| Routes `:1541-1548` | same paths/methods | parity |
| Messages `Jadwal harus 5 field cron`, `Command wajib diisi` | `Schedule must have 5 cron fields`, `Command is required` | deviation (English, §9.3) |
