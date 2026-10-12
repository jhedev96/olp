# TASKS — Phase 12 kill wave 2 (privileged process kill)

> Spec: `SPECS/spec-kill-wave.md` (approved). Scope is kill ONLY
> (CAND-004); restart/services/bulk stay out. Security review rides
> along (spec §7 + diff read before merge).
> Each task = one local commit; branch `<type>/w2-<topic>` → merge.

- [ ] W2-01: sysinfo kill helper (`kill.ts` verdict matrix + tests;
  no `process.*` inside)
- [ ] W2-02: server POST kill route + `kill` dep override + inject
  tests (200/400/403/404/500/401)
- [ ] W2-03: smoke extension (live `sleep` kill/gone, deny-init,
  401) + behavioral ALL GREEN
- [ ] W2-04: frontend per-row Kill + ConfirmDialog + refresh (header
  button behavior unchanged)
- [ ] W2-05: docs (CHANGELOG entry, CAND-004 close-out, INVENTORY_WEB
  monitor row update)

Gate: sysinfo + server + web suites green; smoke ALL GREEN; security
read of the diff recorded in the merge report; no kill-shaped code
outside `kill.ts` + the one route.
