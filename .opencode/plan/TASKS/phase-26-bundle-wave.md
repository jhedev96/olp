# TASKS — Phase 26 full-system bundle wave 16 (manifest + jobs)

> Spec: `SPECS/spec-bundle-wave.md` (approved). Scope is CAND-035
> core (both snapshot + danger restore-all, human-locked); auth
> inclusion splits to CAND-038 (new row W16-06); auto-prune and
> cross-panel import stay out.
> Each task = one local commit; branch `<type>/w16-<topic>` → merge.

- [ ] W16-01: discovery surfaces (db list + cron export/import
  shape if absent) + tests
- [ ] W16-02: snapshot job (enumerate/dump/stage/manifest) +
  tests (deterministic fakes)
- [ ] W16-03: restore-all (guards + replay + report) + tests
- [ ] W16-04: smoke extension (live configs/crons path) +
  behavioral ALL GREEN
- [ ] W16-05: frontend (card + checklist dialog + bundles +
  danger restore + poll) + tests
- [ ] W16-06: docs (CHANGELOG, CAND-035 close + CAND-038 open,
  INVENTORY_WEB backup row)

Gate: server + web suites green; smoke ALL GREEN (configs/crons
path; DB parts inject-proven, recorded); no archive-content
execution anywhere.
