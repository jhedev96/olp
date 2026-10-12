# SPEC — cron insights wave 5 (dry-run, run-now, stats)

> Module ids: `server` (`cron.ts` + new `cron-schedule.ts`,
> `cron-runs.ts` — no new package). Owner: TBD. Status: DRAFT (wave
> direction locked 2026-10-12). Depends on: existing crontab backend.
> Gate: approve before W5-02 (route code).

## 1. Objective

Make cron observable: dry-run validation for all jobs, manual Run Now
with captured results, persisted run history feeding dispatch stats,
next-run countdowns, and daemon PID. System-crond runs stay invisible
(the panel doesn't execute them — documented, not faked). CAND-028
closes; spool paths and category taxonomy stay out (no source).

Success: Dry-Run All reports per-job validity; Run Now executes +
records; stats row reflects panel-triggered runs honestly footnoted;
countdown ticks from server-computed next runs.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/cron-schedule.ts (new, pure — no imports)
export interface CronField { values: Set<number>; }
export function parseCronField(field: string, min: number, max: number, names?: Record<string, number>): CronField | null;
export function nextRunMs(schedule: string, fromMs: number): number | null; // next minute strictly after fromMs, null when unparseable/@-form/empty year

// apps/server/src/cron-runs.ts (new)
export interface RunRecord { id: string; jobId: string; name: string; command: string; startedAt: number; finishedAt: number; exitCode: number | null; timedOut: boolean; latencyMs: number; output: string }
export interface RunStore { list(limit: number): RunRecord[]; append(run: RunRecord): void }
export function fileRunStore(path: string, cap?: number): RunStore; // JSON array, mode 0600, cap 500, corrupt file → []
export function memoryRunStore(cap?: number): RunStore;

// apps/server/src/cron.ts (extend backend + routes)
export interface CronBackend {
  /* ...existing... */
  /** Run a command with capture (Run Now). Rejects only on spawn failure. */
  runCommand(cmd: string, timeoutMs: number): Promise<{ exitCode: number | null; timedOut: boolean; output: string; latencyMs: number }>;
}
export interface CronJob { /* ...existing... */ nextRun: number | null } // ADDITIVE, null when unparseable
export interface CronOptions { backend: CronBackend; runsPath?: string } // omitted → memory store (tests)
// GET /api/cron/jobs -> { jobs } (each + nextRun computed at list time)
// POST /api/cron/jobs/:id/run -> { ok: true, run: RunRecord } (404 unknown id; executes stored command, 60 s timeout, output tail 8 KB)
// GET /api/cron/runs?limit=50 (default 50, max 200) -> { runs: RunRecord[] } (newest first)
// POST /api/cron/jobs/dry-run -> { results: Array<{ id, name, ok, nextRun, resolved: boolean, error: string | null }> }
// GET /api/cron/daemon -> { running: boolean; pid: number | null } (pidof crond, null when absent)
```

### Behavior

- Schedule parser (5 fields, minute/hour/dom/month/dow): `*`,
  `*/step`, `a-b`, `a-b/step`, comma lists, integers; 3-letter
  `mon..sun`/`jan..dec` (case-insensitive); `@`-forms and anything
  else → null (documented limitation, never throw). Standard cron
  dom-vs-dow OR semantics (either field being `*` means the other
  decides; both restricted → either may match).
- `nextRunMs` scans forward minute-by-minute (exclusive of `fromMs`),
  cap one year → null. Pure and deterministic (tests pin timestamps).
- Run Now: looks up the job by id (404 unknown), executes the STORED
  command (never client-supplied — the body carries no command),
  60 s timeout (timedOut, SIGKILL, exitCode null), output = last 8 KB
  of stdout+stderr, records to the store, returns the record.
- Dry-run per job (no execution): schedule parses (else error
  `Invalid schedule`), first command token resolved via
  `hasBin` (token[0] split on whitespace, strip `VAR=x` prefixes and
  sudo-like wrappers? No — first token only, `VAR=` prefixes skipped;
  unresolved → ok:false `Command not found: <token>`), nextRun
  computed. Disabled jobs included with their stored schedule (flagged
  in response? keep `enabled` echo — response adds `enabled: boolean`
  for honest display).
- Daemon: `running` reuses the `pgrep -x crond` probe; `pid` from
  `pidof crond` first integer, null on any failure.
- Run store: file `cron-runs.json` under dataDir (wired in
  `index.ts` from resolved dirs; mode 0600 on write); corrupt/missing
  → []; cap 500 (drop oldest); `list` newest-first.
- Frontend: header next-in countdown (min nextRun, 1 s tick, `—`
  when none); Dry-Run All → results modal (per-job ok/error +
  next run); per-job Run Now button + last-run line (from runs feed
  matched by jobId, `—` when never); stats row (24h panel runs,
  success %, avg latency) footnoted `panel-triggered runs only`;
  battery card via `/api/stats`; daemon PID line; ComingSoon 028
  drops. Spool path/privileges stay out (per-OS, no endpoint).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
Smoke: live dry-run/run-now(`echo` job)/daemon/401s on Linux (job created + deleted inside the script)
```

## 4. Project Structure

```text
apps/server/src/cron-schedule.ts
apps/server/src/cron-runs.ts
apps/server/src/cron.ts                # backend + runCommand + routes
apps/server/test/cron-schedule.test.ts
apps/server/test/cron-runs.test.ts
apps/server/test/cron-routes.test.ts   # + cases (extends file)
smoke/linux.mjs                        # + cron insight checks
apps/web/src/pages/cron.tsx            # wiring (W5-04)
```

## 5. Code Style

- cron-schedule.ts imports NOTHING (pure math on timestamps).
- No `any`; English JSDoc; caps (60 s run, 8 KB tail, 500 runs,
  200 list limit) named as constants.
- Running another user's stored command: same trust as the terminal
  (session gate); never accept a command from the request body.

## 6. Testing Strategy

- schedule: field matrix (stars/steps/ranges/lists/names/invalid),
  nextRun pinned cases incl. leap-day-ish edges, dom/dow OR rule,
  `@reboot` → null, year-cap → null.
- runs store: file round-trip + 0600 perms assertion? (mode check via
  stat — yes, cheap), corrupt → [], cap trim, memory variant.
- backend runCommand: real `echo` (exit 0, output, latency ≥ 0),
  failing (`exit 3`), timeout (`sleep 5` with 200 ms timeout →
  timedOut, exitCode null), missing binary (spawn error rejects).
- routes (fake backend + memory store): jobs carry nextRun; run
  unknown id 404; run records + returns; runs limit clamp; dry-run
  ok/invalid/unresolved rows; daemon pid parse/absent; 401s.
- smoke (behavioral): create `echo` job → dry-run ok → run-now ok
  with output → runs feed contains it → delete job; daemon shape;
  401s. Script deletes its job (idempotent re-runs).
- frontend: countdown text, dry-run modal rows, run posts + refreshes,
  stats math from stubbed runs, footnote present.

## 7. Boundaries

- Always: stored-command-only execution; session gate; caps enforced.
- Ask first: raising run timeout/output caps; auto-runner (executing
  schedules panel-side — explicitly NOT this wave).
- Never: executing request-body commands; parsing system cron logs
  for fake "dispatch" history; touching schedules on dry-run.

## 8. Success Criteria

- [ ] Server build green; unit + inject suites green.
- [ ] Smoke cron checks green live (incl. real `echo` execution).
- [ ] Cron page wired; CAND-028 closed.
- [ ] Existing cron payloads only gain additive fields (old tests
  green unmodified or minimally extended).

## 9. Open Questions

- Panel-side auto-runner (executing due schedules itself): tempting
  for "real" dispatch stats, but duplicates system crond and risks
  double-execution. Rejected for this wave; revisit only with a
  no-double-run design.
- Log scraping (`/var/log/cron`, journald) for system-run history:
  rejected (per-OS fragility, permission roulette).

## 10. Decisions (locked 2026-10-12, human)

- Wave 5 = cron insights (028); spool/category stay out (no source).
- Stats cover panel-triggered runs only, footnoted (no faked system history).
- Stored-command-only Run Now (60 s, 8 KB tail); dry-run never executes.

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Dry-Run All | POST dry-run → results modal |
| Next-in countdown | jobs[].nextRun (min, client tick) |
| Stats row (dispatches/success/latency) | GET runs (panel runs, footnoted) |
| Battery card | `/api/stats` battery (frontend fetch, existing) |
| Daemon PID | GET daemon (pidof, nullable) |
| Run Now per job | POST :id/run + last-run line |
| Crontab Validate/Save-Reload | Out (raw spool editing stays out — crontab modal is read-only by design) |
| Spool path/privileges | Out (per-OS, no endpoint) |
