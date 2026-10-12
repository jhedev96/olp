# TASKS — Phase 22 passkey + local login wave 12 (WebAuthn + loopback)

> Spec: `SPECS/spec-passkey-wave.md` + ADR-007 (approved). Scope is
> CAND-032 core (both methods, human-locked); passwordless-only and
> loopback kill-switch stay out.
> Each task = one local commit; branch `<type>/w12-<topic>` → merge.

- [ ] W12-01: auth config passkey storage (tolerant load) + tests
- [ ] W12-02: dep + `passkey.ts` adapter + 6 passkey endpoints
  (fake-adapter ceremony) + tests
- [ ] W12-03: loopback local login + threat tests (XFWD/LAN deny)
  + tests
- [ ] W12-04: smoke extension (live options-shapes + local) +
  behavioral ALL GREEN (+ record authenticator human gate)
- [ ] W12-05: frontend (login buttons + settings card) + web tests
- [ ] W12-06: docs (CHANGELOG, CAND-032 close, INVENTORY_WEB
  login row)

Gate: auth + server + web suites green; smoke ALL GREEN; password
login byte-identical; no secret in any new response; human gate
recorded for the real-authenticator proof.
