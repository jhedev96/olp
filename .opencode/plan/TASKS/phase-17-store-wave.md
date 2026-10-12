# TASKS — Phase 17 store extras wave 7 (versions, update/upgrade, conf, mirror)

> Spec: `SPECS/spec-store-wave.md` (approved). Scope is CAND-027 core
> only; per-env mirror detection splits to CAND-036 (new row W7-05);
> purge-cache stays out (confirm design needed).
> Each task = one local commit; branch `<type>/w7-<topic>` → merge.

- [ ] W7-01: pkgman versionCmd/conf fields + update/upgrade manager
  commands + evidence spike + tests
- [ ] W7-02: server versions + update/upgrade + mirror endpoints +
  static-beats-parametric proof + tests
- [ ] W7-03: smoke extension (live versions/update/mirror) +
  behavioral ALL GREEN
- [ ] W7-04: frontend (versions, update/upgrade buttons + modal reuse,
  conf Configure `?path=` link, installed-only, mirror card;
  ComingSoon CAND-027 drops) + web tests
- [ ] W7-05: docs (CHANGELOG, CAND-027 close + CAND-036 open,
  INVENTORY_WEB store row)

Gate: pkgman + server + web suites green; smoke ALL GREEN; existing
3-endpoint behavior diff-empty (additive `conf` only); no user input
reaches a shell anywhere in the diff.
