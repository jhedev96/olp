# TASKS — Phase 18 device sessions wave 8 (list, revoke, logout-others)

> Spec: `SPECS/spec-sessions-wave.md` (approved). Scope is CAND-030
> only; remember-me/bind/verified-badge stay CAND-031; CSRF/zero-trust
> mockup copy is an honest drop (no such mechanisms).
> Each task = one local commit; branch `<type>/w8-<topic>` → merge.

- [ ] W8-01: auth UA parser + session metadata (list/touch/revokeById/
  revokeOthers, no-token-serialization proof) + tests
- [ ] W8-02: server login-capture/touch/endpoints + static-beats-param
  proof + tests
- [ ] W8-03: smoke extension (live two-jar lifecycle) + behavioral
  ALL GREEN
- [ ] W8-04: frontend (fmtAgo + sessions card, THIS DEVICE, dialogs;
  ComingSoon CAND-030 drops) + web tests
- [ ] W8-05: docs (CHANGELOG, CAND-030 close, INVENTORY_WEB settings
  row)

Gate: auth + server + web suites green; smoke ALL GREEN; existing
auth behavior diff-empty; no token or raw UA in any response body.
