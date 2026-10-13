# TASKS — Phase 25 per-env mirror + purge wave 15 (deferred live)

> Spec: `SPECS/spec-mirror-wave.md` (approved). Scope is CAND-036
> only (mirror per-env + purge-cache). LIVE DEFERRED with the
> wave-14 gate (box OOM): smoke written in W15-03, RUN when memory
> breathes; merge gated on green.
> Each task = one local commit; branch `<type>/w15-<topic>` → merge.

- [ ] W15-01: pkgman descriptors + 5 parsers + purge map + tests
- [ ] W15-02: server per-env mirror + purge slot + wiring + tests
- [ ] W15-03: smoke extension (mirror/purge checks WRITTEN; live
  run deferred with wave-14 gate)
- [ ] W15-04: frontend purge button + modal kind + tests
- [ ] W15-05: docs (CHANGELOG, CAND-036 close-pending-live,
  INVENTORY_WEB store row)

Gate: pkgman + server + web suites green; smoke ALL GREEN when
runnable (merge held until then, wave-14 rule).
