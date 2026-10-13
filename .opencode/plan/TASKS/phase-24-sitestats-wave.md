# TASKS — Phase 24 per-site stats wave 14 (CPU/RSS/version)

> Spec: `SPECS/spec-sitestats-wave.md` (approved). Scope is CAND-015's
> open half only (self-restart shipped wave 13); autorestart toggle
> stays CAND-020; non-Linux readers stay out (nulls).
> Each task = one local commit; branch `<type>/w14-<topic>` → merge.

- [ ] W14-01: sysinfo `samplePid` targeted + unit tests
- [ ] W14-02: sites pid/version/stats + sampler share + seams +
  inject tests
- [ ] W14-03: smoke extension (live node site stats) +
  behavioral ALL GREEN
- [ ] W14-04: frontend cards + dashboard sum + poll + tests
- [ ] W14-05: docs (CHANGELOG, CAND-015 close, INVENTORY_WEB
  sites row)

Gate: sysinfo + server + web suites green; smoke ALL GREEN; list
shape additive-only; no per-list version spawn anywhere.
