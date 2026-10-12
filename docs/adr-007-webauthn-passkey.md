# ADR-007 — WebAuthn Passkey Ceremony Library

> Status: accepted 2026-10-12 (wave 12 design gate, human Q&A).
> Context: CAND-032 (hardware passkey + platform biometric — one
> ceremony). Rule: new dependencies need an evidence spike + ADR.

## Spike evidence (2026-10-12, `npm view`)

- `@simplewebauthn/server@14.0.3`: `≈ 780 KB` unpacked. Deps are
  ASN.1/X.509 plumbing (`@peculiar/*`, `@hexagon/base64`,
  `reflect-metadata`) — no native modules, no postinstall, no
  network calls of its own. The standard reviewed WebAuthn server
  implementation (used by major frameworks; audited ceremony code).
- Client side needs nothing: `navigator.credentials.create/get`
  is browser-native (all modern browsers + Android WebView).
- Hand-rolled ceremony explicitly rejected: signature/counter/
  attestation verification is cryptographic protocol code — a
  single-admin panel must not invent it (same rule that keeps
  PBKDF2 inside `@olp/auth` primitives).

## Decision

1. **`@simplewebauthn/server`** for challenge generation and both
   verifications, behind a thin adapter interface (`PasskeyOps`)
   so tests inject deterministic fakes (no authenticator in CI).
2. Client uses raw `navigator.credentials` (no
   `@simplewebauthn/browser` — the two calls we need are trivial;
   one less dep).
3. RP ID = request hostname (Fastify `req.hostname`, no port).
   `localhost` is cert-safe; LAN-IP RP IDs may fail in some
   browsers — the login button surfaces the browser error
   honestly and password always remains (human-locked fallback).

## Rejected

- Hand-rolled attestation/assertion verification (see above).
- `@simplewebauthn/browser`: unnecessary for create/get wrappers.
- `fido2-lib` (older, heavier, less maintained).

## Consequences

- `apps/server/package.json` gains `@simplewebauthn/server`
  (exact minor pinned at implementation; lockfile updated).
- Credentials persist in `config.json` (`passkeys` array, 0600 —
  public keys only, never secrets).
- Challenges live in memory (5-minute single-flight map, pruned
  on access) — restart invalidates pending ceremonies (consistent
  with session behavior).
