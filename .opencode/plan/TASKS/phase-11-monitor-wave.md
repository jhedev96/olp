# TASKS — Phase 11 monitor wave 1 (read-only telemetry)

> Spec: `SPECS/spec-monitor-wave.md` (approved). Backend reopens here —
> rules §10.6 freeze is lifted for this wave's scope only (CAND-001,
> CAND-002, CAND-003, CAND-014). Kill/restart/log/services stay out.
> Each task = one local commit; branch `<type>/w1-<topic>` → merge.

- [ ] W1-01: sysinfo monitor providers (`monitor.ts`, `arch()` dep,
  fixture tests, 512-pid cap, truncation, sampler null-then-delta)
- [ ] W1-02: server `monitor.ts` routes + inject tests (shape, limit
  clamp, 401, pm2-null, stats untouched)
- [ ] W1-03: smoke extension (`summary`/`processes`/401 checks) + live
  behavioral PASS/FAIL on Linux
- [ ] W1-04: frontend monitor wiring (summary+processes cadence,
  per-core bars, net ring buffer, proc DataTable, pm2-conditional;
  ComingSoon drops only for shipped fields)
- [ ] W1-05: docs (CHANGELOG entry, CAND-001/002/003/014 close-out,
  INVENTORY_WEB monitor row update)

Gate: sysinfo + server + web suites green; smoke ALL GREEN incl. new
checks; `/api/stats` diff-empty; no kill-shaped code anywhere in the diff.
