# TASKS — Phase 13 daemon wave 3 (Services & Daemons)

> Spec: `SPECS/spec-daemon-wave.md` (approved). Scope is CAND-005 only:
> status via presence + best-effort START. Per-distro unit tables, STOP
> buttons, and auto-start stay out.
> Each task = one local commit; branch `<type>/w3-<topic>` → merge.

- [ ] W3-01: sysinfo daemon presence (`daemons.ts` + cap/skip tests)
- [ ] W3-02: server services routes + controller seam + inject tests
  (shape/404/error/500/401)
- [ ] W3-03: smoke extension (live shape + honest-error + 401) +
  behavioral ALL GREEN
- [ ] W3-04: dashboard section wiring (ACTIVE/START/error line;
  ComingSoon CAND-005 drops)
- [ ] W3-05: docs (CHANGELOG entry, CAND-005 close-out, INVENTORY_WEB
  dashboard row update)

Gate: sysinfo + server + web suites green; smoke ALL GREEN; no other
route's payload changed (stats/monitor suites green unmodified).
