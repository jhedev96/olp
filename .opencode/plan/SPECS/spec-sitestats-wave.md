# SPEC — per-site stats wave 14 (CPU/RSS/version, shared sampler)

> Modules: `sysinfo` (targeted pid sample) + `server` (`sites.ts`,
> `monitor.ts` sampler share, `index.ts` wiring) + `web` (sites
> cards, dashboard total). No new dep. Owner: TBD.
> Status: DRAFT (locked 2026-10-13, human Q&A).
> Depends on: monitor wave (parsers + delta semantics), sites
> runtime, store versions pattern (first-line caps).
> Gate: approve before W14-01 (first code).

## 1. Objective

Close CAND-015's open half (panel self-restart already shipped in
wave 13): per-site PID + CPU% + RSS + engine version on the website
cards, with a dashboard total-RAM sum, all honestly nulled where
the platform or timing cannot provide.

Success: a started node site lists `pid` + `engineVersion`
(`v24…`) + numeric `memBytes` (+ `cpuPercent` latest by second
poll); stopped sites read nulls; non-Linux reads nulls; smoke
proves it live against real node.

## 2. API Contract (TypeScript)

```ts
// packages/sysinfo/src/monitor.ts
export function samplePid(
  deps: SysDeps, sampler: MonitorSampler, pid: number,
): Promise<{ cpuPercent: number | null; memBytes: number } | null>;
 // null = unreadable/termux-absent; cpu null-first-poll (sampler deltas shared with sampleProcesses)

// apps/server/src/sites.ts
export interface SiteProcess { pid: number | null; /* ...existing... */ }
export interface SitesOptions {
  /* ...existing... */
  procStats?: (pid: number) => Promise<{ cpuPercent: number | null; memBytes: number } | null>;
  runVersion?: (bin: string) => Promise<string | null>;
}
// GET /api/sites items gain: pid: number | null, cpuPercent: number | null,
//   memBytes: number | null, engineVersion: string | null (null when stopped/absent)
```

### Behavior

- `samplePid` reads only `/proc/<pid>/stat` + `/status`
  (targeted — never the 512-pid scan), reusing `parsePidStat` /
  `parsePidStatus` and the SHARED `sampler.prevPid` /
  `prevSysTotal` maps (one delta timeline with the monitor page;
  raced exits → null, never throws).
- Sampler sharing: `buildServer` creates ONE `createMonitorSampler()`,
  passes to monitor (new optional `sampler?`, default creates own —
  existing tests/behavior untouched) and to sites as the `procStats`
  closure. Deltas stay consistent across both pages.
- PID plumbing: real spawner sets `pid: child.pid ?? null`;
  fakes answer `null` (or fixed pids in tests). `Running` gains
  `{pid, engineVersion}` captured at START (single cheap spawn,
  never per-list).
- Version map (type → argv, shell-free): node `node --version`,
  php `php --version`, static `python3 --version`, go `go version`.
  First stdout line ≤80 chars, 3 s cap, any failure → null
  (pre-wave running sites keep null until restart — documented,
  honest).
- List calls `procStats` per RUNNING pid in parallel; failures →
  null row fields (never fail the listing). Stopped sites skip
  probing entirely (no spawn, no sample).
- Frontend sites cards: `CPU x% · Mem y · PID n · engine ver`
  lines (null → muted `—`); dashboard total-RAM = client sum of
  non-null `memBytes` (`Total Alloc RAM: a / b` mockup shape,
  denominator = system total from stats); 5 s auto-poll while ANY
  site runs (stops with the last one — same pattern as log modal).
- Autorestart toggle stays CAND-020 (not this wave — display
  only if already... no: out entirely, no toggle UI).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/sysinfo && npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/sysinfo && npm run test --workspace=@olp/server
Smoke: live node site start -> pid numeric + engineVersion string + memBytes numeric -> stop -> nulls -> delete
```

## 4. Project Structure

```text
packages/sysinfo/src/monitor.ts               # samplePid (W14-01)
packages/sysinfo/test/monitor.test.ts         # + targeted cases (check name first)
apps/server/src/sites.ts                      # pid/version/stats (W14-02)
apps/server/src/monitor.ts                    # optional sampler (W14-02)
apps/server/src/index.ts                      # one sampler + seams (W14-02)
apps/server/test/sites-routes.test.ts         # + cases
smoke/linux.mjs                               # + site-stats checks (W14-04)
apps/web/src/pages/sites.tsx                  # card lines + poll (W14-05)
apps/web/src/pages/dashboard.tsx              # total RAM sum (W14-05)
```

## 5. Code Style

- No shell strings for versions (argv via the exec seam takes a
  full command string? — sysDeps.exec is string-based; bins are
  catalog-fixed (`node --version`), never user input — document
  the fixed-string exception like store commands).
- Parallel per-pid sampling (`Promise.all`, never sequential).
- No `any`; English JSDoc; caps as named constants (3 s, 80
  chars, 5 s poll).

## 6. Testing Strategy

- sysinfo (fixture `/proc` texts): targeted parse (stat+status
  → shares + bytes), null on missing/raced, null-first-cpu
  then value on second sample (shared-map semantics with a
  hand-primed sampler).
- server (inject + fakes): start captures pid + version once
  (assert `runVersion` call count stays 1 across 3 lists);
  list shape with faked stats; stopped → nulls without
  probing (assert zero `procStats` calls); failing probes →
  nulls, listing 200; monitor sampler shared (shape only).
- smoke (behavioral): real node start → numeric pid +
  `v…` version + numeric mem → stop → nulls → delete.
- frontend: card lines render/placeholder, 5 s poll only
  while running (fake timers: no poll after stop), dashboard
  sum with null-skipping.

## 7. Boundaries

- Always: session gate (no new public surface — list shape
  additive); fixed version strings only; caps enforced.
- Ask first: Windows/macOS native per-proc stats (needs new
  readers); autorestart actuation (CAND-020 territory).
- Never: shell user input; per-list version spawns; blocking
  the listing on slow probes (parallel + nulls).

## 8. Success Criteria

- [ ] sysinfo + server builds green; inject suites green.
- [ ] Smoke site-stats checks green live (real node).
- [ ] Sites + dashboard wired; CAND-015 closed.
- [ ] Existing behavior diff-empty except additive list fields
  (monitor shapes untouched; sampler share invisible).

## 9. Open Questions

- macOS/Windows per-proc readers (`ps` parsing?): future wave
  with on-device evidence; nulls until then.
- Autorestart toggle: CAND-020, untouched.

## 10. Decisions (locked 2026-10-13, human Q&A)

- Engine version captured once at start (no per-list spawn
  storm; pre-wave sites null until restart).
- 5 s auto-poll while any site runs (log-modal pattern).

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Per-card CPU Load % | shared-sampler delta (null-first-poll, null off-Linux) |
| Per-card Memory MB | targeted VmRSS (null off-Linux/stopped) |
| Engine + version (`Node.js 20.11`) | start-captured first line (type + version) |
| PID row | spawner pid (null in pipe-fakes) |
| Total Alloc RAM | client sum over list (denominator = system total) |
| Auto-restart toggle | OUT → CAND-020 |
