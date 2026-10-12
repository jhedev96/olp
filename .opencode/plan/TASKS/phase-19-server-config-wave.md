# TASKS — Phase 19 server config wave 9 (remember-me, badge, bind, drop)

> Spec: `SPECS/spec-server-config-wave.md` (approved). Scope is
> CAND-031 core only; editable bind splits to CAND-037 (new row
> W9-05); factory reset stays out (not in CAND-031 text).
> Each task = one local commit; branch `<type>/w9-<topic>` → merge.

- [ ] W9-01: auth per-session TTL + cookie age + tests (TTL/cookie
  pairing invariant)
- [ ] W9-02: server remember login + getMe + bind + identity +
  wiring + tests
- [ ] W9-03: smoke extension (live remember/bind/identity) +
  behavioral ALL GREEN
- [ ] W9-04: frontend (login checkbox, verified badge, bind card,
  fmtIn + row expiry; ComingSoon CAND-031 drops) + web tests
- [ ] W9-05: docs (CHANGELOG, CAND-031 close + CAND-037 open,
  INVENTORY_WEB settings row)

Gate: auth + server + web suites green; smoke ALL GREEN; login
default 24h byte-identical; no token in any new response.
