# SPEC — server config wave 9 (remember-me, verified badge, bind card, PBKDF2 drop)

> Module ids: `auth` (per-session TTL + cookie age) + `server`
> (`auth.ts`, `settings.ts`, `telegram.ts` — no new package). Owner: TBD.
> Status: DRAFT (wave direction locked 2026-10-12, human Q&A).
> Depends on: wave-8 sessions + settings/telegram specs.
> Gate: approve before W9-01 (first code).

## 1. Objective

Close CAND-030's neighbor CAND-031's shippable core: per-session
30-day remember-me (login checkbox wired end to end), telegram
verified badge via a stored-token `getMe` proxy, a read-only bind
card (host:port + loopback badge), and the PBKDF2 310k/rehash drop
with recorded rationale. Editable bind splits to CAND-037 (needs a
restart-capable config design — precedence, validation, recovery).

Success: checking remember yields a 30-day cookie AND a 30-day
session (both sides, never one); a configured bot shows @name
Verified; the bind card tells loopback from LAN honestly; no 310k
text ships anywhere; smoke proves remember + bind + identity live.

## 2. API Contract (TypeScript)

```ts
// packages/auth/src/sessions.ts
export const REMEMBER_TTL_MS = 30 * 86400 * 1000;
export interface SessionInfo extends SessionMeta {
  id: string; created: number; lastSeen: number; expiresAt: number; current: boolean;
}
export class SessionStore {
  create(meta: SessionMeta, options?: { ttlMs?: number; now?: number }): string;
  // validate/touch/list/revokeById/revokeOthers/prune honor expiresAt (not created+TTL)
}

// packages/auth/src/cookies.ts
export const REMEMBER_MAX_AGE = 30 * 86400;
export function loginCookie(token: string, maxAgeSec?: number): string; // default SESSION_MAX_AGE

// apps/server/src/auth.ts
// POST /api/login { username, password, remember? } — remember===true -> 30d session + 30d cookie

// apps/server/src/telegram.ts
export interface TelegramApi { /* ...existing... */ getMe(botToken: string): Promise<string>; } // bot username

// apps/server/src/settings.ts
export interface SettingsRouteOptions { /* ...existing... */ botUsername?: () => Promise<string | null> }
export interface BindInfo { host: string; port: number; loopback: boolean }
// GET /api/settings += { bind: BindInfo } (env-sourced, same defaults as boot)
// GET /api/settings/telegram/identity -> { username: string | null }
```

### Behavior

- TTL lives on the session (`expiresAt = created + ttlMs`);
  `validate`/`touch`/`list`/`revokeById`/`revokeOthers`/`prune`
  all honor it (single source of truth — a 30-day cookie with a
  24-hour session, or vice versa, is a bug by definition).
- Cookie `Max-Age` always matches its session TTL (24h default,
  30d remembered). Existing cookie tests keep passing (default
  param preserves the exact string).
- Identity proxy uses the STORED token only (request bodies never
  supply tokens — a client-supplied token would turn the endpoint
  into an oracle). `null` when disabled/unset/any failure (timeout,
  bad token, offline) — never throws, never leaks the token or the
  API error verbatim? (API `description` like "Unauthorized" is safe
  to surface? No — answer `username: null`, no error field. Silent
  null keeps the badge honest without token probing feedback.)
- Bind info reads the same env keys as boot (`PANEL_HOST` default
  `127.0.0.1`, `PANEL_PORT` default `8080`); `loopback` is
  `host ∈ {127.0.0.1, localhost, ::1}`. LAN bind renders a warning
  badge (never expose directly — AGENTS.md gotcha, linked).
- PBKDF2 drop: no 310k/rehash UI ships (verify: grep); the login
  120k badge (truth) stays; rationale lives in §10 + a code comment
  where the mockup mapped it (settings doc comment rewrite).
- Frontend: login checkbox enabled → posts `remember`; telegram
  card verified badge (`@{username}` Verified / `Unverified`
  muted / loading placeholder); bind card (mono host:port,
  loopback-success vs LAN-warning, pointer to daemon-reload docs);
  sessions rows gain `Expires {fmtIn(...)}` via a new `fmtIn`
  helper (`in 30d/in 5h`; past → `expired`).
- `getMe` reuses the existing 10 s `getJson` transport (no new
  network surface, same timeout semantics as `getUpdates`).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/auth && npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/auth && npm run test --workspace=@olp/server
Smoke: live login remember:true -> cookie Max-Age 2592000 + row expiresAt ~30d -> identity shape null (offline-honest) -> bind {127.0.0.1, port, loopback:true} -> cleanup
```

## 4. Project Structure

```text
packages/auth/src/sessions.ts               # expiresAt + ttl option
packages/auth/src/cookies.ts                # max-age param + REMEMBER_MAX_AGE
packages/auth/test/auth.test.ts             # + cases (extends file)
apps/server/src/telegram.ts                 # getMe (transport reuse)
apps/server/src/auth.ts                     # remember login (one domain file)
apps/server/src/settings.ts                 # bind + identity (one domain file)
apps/server/src/index.ts                    # botUsername wiring
apps/server/test/auth-routes.test.ts        # + remember cases
apps/server/test/settings-telegram.test.ts  # + bind/identity cases
smoke/linux.mjs                             # + server-config checks
apps/web/src/lib/format.ts                  # fmtIn (W9-04)
apps/web/src/pages/login.tsx                # checkbox wiring (W9-04)
apps/web/src/pages/settings.tsx             # badge + bind card (W9-04)
```

## 5. Code Style

- TTL/age constants paired by name (`REMEMBER_TTL_MS` /
  `REMEMBER_MAX_AGE`) with a comment tying them (drift = bug).
- No `any`; English JSDoc; identity thunk typed
  `() => Promise<string | null>` (settings never imports the Bot API).

## 6. Testing Strategy

- auth pkg: TTL matrix (default 24h expiry, 30d honored, mixed
  lifetimes prune independently); cookie max-age default + 30d
  strings; `create` options backward-compat (old positional callers
  updated, none left).
- server (inject + fakes): login remember sets 30d cookie AND
  30d `expiresAt` (both asserted together — the wave's core
  invariant); default login unchanged; identity null (disabled) /
  username (fake thunk) / null (throwing thunk) + 401; bind shape
  (defaults under test env) + loopback true; `getMe` unit shape
  via fake transport (username extraction, bad-shape throw).
- smoke (behavioral): remember login → `Max-Age=2592000` in
  Set-Cookie + sessions row `expiresAt - created ≈ 30d`; identity
  `{username: null}` (no token on box); bind matches SMOKE port +
  loopback true.
- frontend: checkbox posts `remember: true/false`; badge three
  states; bind card loopback vs LAN rendering; `fmtIn` matrix;
  sessions rows show expiry; CAND-031 ComingSoon drops.

## 7. Boundaries

- Always: session gate on identity; stored-token-only proxy;
  cookie/session TTL paired; LAN-bind warning shown (never
  encourage exposure).
- Ask first: editable bind (CAND-037 scope); sliding expiry;
  per-IP allowlists (both still out).
- Never: client-supplied tokens to Telegram; raw UA/token in new
  responses; auto-relogin or token refresh.

## 8. Success Criteria

- [ ] auth + server builds green; inject suites green.
- [ ] Smoke server-config checks green live.
- [ ] Login + settings wired; CAND-031 closed (minus editable
  bind → 037).
- [ ] Existing behavior diff-empty except additive `bind`,
  `expiresAt`, `remember`, `getMe` (login default 24h byte-identical).

## 9. Open Questions

- Editable bind (CAND-037): precedence (env vs file), validation,
  failed-restart recovery — needs its own spec, planned carefully
  per human direction.
- Native-app remember UX (biometric-gated store?): CAND-032
  territory, not here.

## 10. Decisions (locked 2026-10-12, human Q&A)

- PBKDF2 310k text + rehash flag DROPPED (no cryptographic effect;
  contradicts the real 120k in `packages/auth`; login keeps the
  truthful 120k badge). Rationale recorded here + settings comment.
- Bind wave 9 = read-only card; editable + restart flow → CAND-037
  (planned carefully, separate spec).
- Remember-me = per-session 30d TTL (cookie + session paired),
  default stays 24h.

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Remember 30-day checkbox (login) | login `remember` → 30d cookie + session |
| Telegram verified `@Bot` badge | identity proxy (stored token, null-honest) |
| PANEL_HOST/PORT + loopback lock display | bind card (read-only, loopback badge, LAN warning) |
| Reload via terminal docs | existing daemon-reload card (untouched, linked) |
| PBKDF2 310k + rehash flag | DROPPED (§10) |
| Reset-to-factory card | OUT — not in CAND-031 text (destructive, own design) |
| Editable host/port + lock toggle | OUT → CAND-037 |
