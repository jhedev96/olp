# TASKS — Phase 27 auth-config bundle wave 17 (CAND-038)

> Spec: `SPECS/spec-auth-bundle-wave.md` (approved). Scope is
> CAND-038 only (reauth + rollback + revoke); CAND-039 (formatter
> parsers) is a separate frontend task, not this wave.
> Each task = one local commit; branch `<type>/w17-<topic>` → merge.

- [ ] W17-01: `parseAuthConfig` export + tests
- [ ] W17-02: snapshot `auth.json` + `hasAuth` + restore-auth step
  + revoke wiring + tests (deterministic fakes)
- [ ] W17-03: smoke extension (auth restore → 401 → re-login;
  live run deferred with phase 26)
- [ ] W17-04: frontend (password field + logout copy) + tests
- [ ] W17-05: docs (CHANGELOG, CAND-038 close, INVENTORY_WEB
  backup row)

Gate: auth + server suites green; smoke ALL GREEN or
recorded-deferred (box OOM, with phase 26); no credential bytes
in any response/log anywhere.
