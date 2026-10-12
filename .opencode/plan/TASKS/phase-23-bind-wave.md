# TASKS — Phase 23 editable bind + restart wave 13 (careful plan)

> Spec: `SPECS/spec-bind-wave.md` (approved). Scope is CAND-037
> only; systemd/PM2 generation stays out; CAND-015 keeps its
> site-stats half.
> Each task = one local commit; branch `<type>/w13-<topic>` → merge.

- [ ] W13-01: settings schema + resolve/validate pure + matrix
  tests (no endpoints yet)
- [ ] W13-02: bind save/get endpoints + report holder + tests
- [ ] W13-03: boot resolve + listenWithFallback + restart
  endpoint + exit seam + tests
- [ ] W13-04: smoke extension (save/restart-exit LAST) +
  behavioral ALL GREEN
- [ ] W13-05: frontend bind editor + restart flow + tests
- [ ] W13-06: docs (CHANGELOG, CAND-037 close, 015-note,
  INVENTORY_WEB settings row)

Gate: server + web suites green; smoke ALL GREEN (summary prints
after restart-death); default boot path byte-identical; no silent
bind change anywhere in the diff.
