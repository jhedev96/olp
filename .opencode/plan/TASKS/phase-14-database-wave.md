# TASKS — Phase 14 database wave 4 (create + schema info)

> Spec: `SPECS/spec-database-wave.md` (approved). Scope is CAND-006 +
> CAND-026 only; import/export (025) and Redis (024) stay out. No
> live-DB gate exists in the agent box — fake-driver coverage + SQL
> review + recorded human gate (see spec §6).
> Each task = one local commit; branch `<type>/w4-<topic>` → merge.

- [ ] W4-01: driver methods (`createDatabase`/`tableStats`/`tableDef`
  × mysql+pg, short-lived conns, identifier discipline) + build green
- [ ] W4-02: routes + fake-driver inject tests (400/409/403/500,
  shapes incl. null-ddl pg path)
- [ ] W4-03: frontend (New Database dialog, schema badges, DDL modal,
  data-vs-index panel) + web tests
- [ ] W4-04: docs (CHANGELOG entry, CAND-006/026 close-out,
  INVENTORY_WEB database row, manual live-DB gate in TODOS)

Gate: server + web suites green; existing 9-endpoint suite green
unmodified; no DROP-shaped code anywhere in the diff.
