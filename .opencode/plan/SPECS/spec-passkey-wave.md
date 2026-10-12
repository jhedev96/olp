# SPEC — passkey + local login wave 12 (WebAuthn + loopback)

> Modules: `auth` (passkey storage) + `server` (`auth.ts` passkey +
> local routes, `config` shape) + `web` (login + settings).
> New dep: `@simplewebauthn/server` (ADR-007; client uses native
> `navigator.credentials`, no browser dep).
> Owner: TBD. Status: DRAFT (locked 2026-10-12, human Q&A).
> Depends on: sessions (metadata + TTL), settings page.
> Gate: approve before W12-01 (first code).

## 1. Objective

Close CAND-032's shippable core: WebAuthn passkey register + login
(hardware keys and platform biometrics in one ceremony, password
stays primary) and loopback one-click local login, both wired to
the login buttons and a settings passkey card.

Success: a registered key logs in without a password; a lost key
changes nothing (password works); localhost one-click works and
LAN-URL clicks fail honestly; smoke proves options + local live
and documents the authenticator human gate.

## 2. API Contract (TypeScript)

```ts
// packages/auth/src/config.ts (additive)
export interface PasskeyCredential { id: string; publicKey: string; counter: number; name: string; created: number }
export interface AuthConfig { /* ...existing... */ passkeys: PasskeyCredential[] } // absent on disk -> []

// apps/server/src/auth.ts (adapter seam for tests)
export interface PasskeyOps {
  registrationOptions(user: { id: string; name: string }, rp: { id: string; name: string }): Promise<{ options: unknown; challenge: string }>;
  verifyRegistration(response: unknown, expected: { challenge: string; origin: string; rpId: string }): Promise<{ id: string; publicKey: string; counter: number }>;
  authenticationOptions(allow: string[], rpId: string): Promise<{ options: unknown; challenge: string }>;
  verifyAuthentication(response: unknown, expected: { challenge: string; origin: string; rpId: string; credential: { id: string; publicKey: string; counter: number } }): Promise<{ counter: number }>;
}
// POST /api/auth/passkey/register/options  (authed) -> { options } (+ server-stashed challenge)
// POST /api/auth/passkey/register/verify   (authed, { name?, response }) -> { ok: true, id }
// GET  /api/auth/passkeys                  (authed) -> { passkeys: [{ id, name, created }] }
// DELETE /api/auth/passkeys/:id            (authed) -> { ok: true } (unknown -> 404)
// POST /api/auth/passkey/login/options     (PUBLIC) -> { options, state }
// POST /api/auth/passkey/login/verify      (PUBLIC, { state, response }) -> { ok: true } + session cookie
// POST /api/login/local                    (PUBLIC) -> { ok: true } + session cookie, loopback-only else 403
```

### Behavior

- Challenges: in-memory map `state → {challenge, created}`
  (8-hex state ids, 5-minute TTL, pruned on access, cap 20
  entries — oldest evicted). Restart kills pending ceremonies
  (consistent with sessions; documented).
- RP ID = `req.hostname`, origin = request protocol+host
  (Fastify `req.protocol` + hostname; behind no proxy — same
  trust as `req.ip`). Mismatches fail closed (400 + lib message
  capped 200 chars).
- Registration requires auth (attacker can't enroll keys);
  login-verify mints a normal 24h session (remember-me stays a
  password-login feature — passkey sessions are 24h, documented).
- Credential ids are public (like session public ids); public
  keys persist in `config.json` 0600 (public-key material only).
  Counter updates on each login (clone detection left to the
  lib's verification — we pass the stored counter through).
- `POST /api/login/local`: `req.ip` loopback-only
  (`127.0.0.1/::1/::ffff:127.0.0.1`, no `X-Forwarded-For`
  ever). Else 403 `{error}` naming loopback-only. Creates a
  normal 24h session with metadata browser `Local login`.
  ACCEPTED RESIDUAL (human-locked): any localhost process —
  including other phone apps — can use it. Mitigations in-wave:
  strict-loopback only (LAN URLs fail), confirm dialog copy
  states the risk, spec records it. A settings kill-switch is
  NOT in wave (follow-up if the human wants it).
- Frontend login: passkey button enabled iff
  `window.PublicKeyCredential !== undefined` (else disabled +
  reason); local button always enabled (server decides) behind
  a ConfirmDialog with the localhost warning; both surface
  errors inline and `goto('/dashboard')` on `{ok:true}`.
- Settings: passkeys card (list + name input + Register via
  `navigator.credentials.create` + per-row Delete + dialog);
  badge count. Client ceremony errors surface inline (LAN-IP
  RP failures land here honestly).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server && npm run test --workspace=@olp/auth
Smoke: live login/options shape (challenge present) + register/options 401-unauth-proof... (authed shape) + local login ok on loopback + forged-XFWD still loopback-gated -> cleanup
```

## 4. Project Structure

```text
packages/auth/src/config.ts                  # passkeys array + tolerant load (W12-01)
packages/auth/test/auth.test.ts              # + storage cases
apps/server/src/passkey.ts                   # adapter over simplewebauthn + challenge map (W12-02)
apps/server/src/auth.ts                      # 7 endpoints + local login (W12-02/03)
apps/server/test/auth-routes.test.ts         # + fake-adapter ceremony + local cases
apps/server/package.json                     # + @simplewebauthn/server (W12-02, lockfile)
smoke/linux.mjs                              # + passkey-shape + local checks (W12-04)
apps/web/src/pages/login.tsx                 # button wiring (W12-05)
apps/web/src/pages/settings.tsx              # passkeys card (W12-05)
docs/adr-007-webauthn-passkey.md             # (this wave planning)
```

## 5. Code Style

- Adapter returns plain data (no lib types leak past `passkey.ts`;
  server code depends on `PasskeyOps` only — tests never import
  the real lib).
- Challenge/state ids via `randomBytes` (8 hex, same grade as
  session public ids); constant-time compare unnecessary
  (single-admin, online-gated).
- No `any`; English JSDoc; caps as named constants (5-min
  challenge, 20-entry cap, 200-char error cap).

## 6. Testing Strategy

- auth pkg: config load with absent/corrupt `passkeys` → [];
  save round-trip preserves credentials.
- server (inject + fake adapter): register options authed shape
  + 401; register verify stores + lists + deletes (404
  unknown); login options PUBLIC shape (challenge + state);
  login verify mints session cookie + updates counter, bad
  state → 400, unknown credential → 401; local login ok on
  inject-default loopback (127.0.0.1) + 403 with forged
  `X-Forwarded-For` non-loopback? (req.ip ignores XFWD —
  assert a LAN `remoteAddress` 403s); static/public gates
  (register/* 401 without cookie).
- smoke (behavioral): login/options + register/options shapes
  live (real lib, real challenges); local login ok + session
  works + revoke cleanup. Full ceremony needs a real
  authenticator → HUMAN GATE (recorded, like the live-DB gate).
- frontend: passkey unsupported disables with reason; local
  confirm flow posts + redirects; settings register/delete
  flows with stubbed `navigator.credentials`; CAND-032 gone.

## 7. Boundaries

- Always: registration behind auth; login-verify mints 24h
  sessions; stored-token-free design (no secrets in new
  responses — challenges are single-use nonces, public by
  design); strict loopback (no proxy headers).
- Ask first: passwordless-only mode (locked OUT — password
  stays); loopback kill-switch; ML-DSA/other ceremonies.
- Never: hand-rolled ceremony crypto; client-supplied RP ID /
  origin / challenge; trusting `X-Forwarded-For` for the local
  gate; persisting challenges.

## 8. Success Criteria

- [ ] Server + auth builds green; inject suites green.
- [ ] Smoke passkey-shape + local checks green live.
- [ ] Login + settings wired; CAND-032 closed (pipe = loopback
  semantic, documented).
- [ ] Existing auth behavior diff-empty (password login
  byte-identical; config load tolerates old files).

## 9. Open Questions

- Real-authenticator ceremony proof: HUMAN GATE (needs a
  security key / platform biometric on the human's machine;
  recorded in TODOS like the live-DB gate).
- LAN-IP RP-ID failures: browser-dependent, surfaced honestly;
  no workaround in wave.

## 10. Decisions (locked 2026-10-12, human Q&A)

- BOTH methods in wave 12 (passkey + loopback local).
- `@simplewebauthn/server` + ADR-007 (no hand-rolled crypto;
  no browser dep).
- Password stays primary (no passwordless-only mode).
- Loopback residual accepted (strict-loopback + warning copy;
  kill-switch is a follow-up, not this wave).

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Hardware passkey button (login) | login/options + verify + session (biometric included, same ceremony) |
| Local pipe auth button (login) | `POST /api/login/local` (loopback-proof semantic; pipe = local machine) |
| Passkey management UI | settings card (register/list/delete, authed) |
