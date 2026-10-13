# TASKS — Phase 29 ops dummies sweep wave 19 (CAND-013/016/019)

> Spec: `SPECS/spec-ops-sweep-wave.md` (approved). Three small
> endpoints, no shared machinery; each backend task owns its
> tests. Frontend + smoke + docs close the wave.
> Each task = one local commit; branch `<type>/w19-<topic>` → merge.

- [ ] W19-01: files `mode` field + `POST /api/chmod` + tests
- [ ] W19-02: mounts module + `GET /api/mounts` + tests
- [ ] W19-03: log ring + `GET /api/logs` + feed points + tests
- [ ] W19-04: smoke extension (live or recorded-deferred)
- [ ] W19-05: frontend (log card, mode/chmod, mounts card) + tests
- [ ] W19-06: docs (CHANGELOG, CAND-013/016/019 close, INVENTORY rows)

Gate: server + web suites green; smoke ALL GREEN or
recorded-deferred (box OOM); no invented lines/entries anywhere.
