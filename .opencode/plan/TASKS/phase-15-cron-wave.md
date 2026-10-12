# TASKS — Phase 15 cron insights wave 5 (dry-run, run-now, stats)

> Spec: `SPECS/spec-cron-wave.md` (approved). Scope is CAND-028 only;
> spool/category stay out; no auto-runner, no log scraping.
> Each task = one local commit; branch `<type>/w5-<topic>` → merge.

- [ ] W5-01: schedule parser + run store (`cron-schedule.ts`,
  `cron-runs.ts`, pinned unit tests, 0600 file test)
- [ ] W5-02: backend `runCommand` + routes (additive nextRun, run,
  runs, dry-run, daemon) + inject tests
- [ ] W5-03: smoke extension (live `echo` job lifecycle) + behavioral
  ALL GREEN (script deletes its job)
- [ ] W5-04: frontend (countdown, dry-run modal, Run Now, stats row,
  battery card, daemon PID; ComingSoon CAND-028 drops)
- [ ] W5-05: docs (CHANGELOG entry, CAND-028 close-out, INVENTORY_WEB
  cron row update)

Gate: server + web suites green; smoke ALL GREEN; existing cron
payloads only gain additive fields; no request-body command execution
anywhere in the diff.
