# TASKS — Phase 16 backup advanced wave 6 (verify, gzip, upload, schedules)

> Spec: `SPECS/spec-backup-wave.md` (approved). Scope is CAND-029 core
> only; full-system splits to CAND-035 (new row this wave); auto-prune
> stays out (retention design needed).
> Each task = one local commit; branch `<type>/w6-<topic>` → merge.

- [ ] W6-01: sha256 sidecar + verify endpoint + stream-hash tests
- [ ] W6-02: gzip dump variant (create/restore/`.sql.gz`) + command tests
- [ ] W6-03: upload import (50 MB cap, typed, round-trip) + tests
- [ ] W6-04: schedules CRUD + ticker + due math + tests (no waiting)
- [ ] W6-05: smoke extension (live round-trips + ~70 s schedule wait)
  + behavioral ALL GREEN
- [ ] W6-06: frontend (verify badges, gzip toggle, upload, schedules
  section; ComingSoon CAND-029 drops) + web tests
- [ ] W6-07: docs (CHANGELOG, CAND-029 close + CAND-035 open,
  INVENTORY_WEB backup row)

Gate: server + web suites green; smoke ALL GREEN; existing 5-endpoint
behavior diff-empty (additive only); no archive-content execution
anywhere in the diff.
