# SPEC — device sessions wave 8 (list, revoke, logout-others)

> Module ids: `auth` (session metadata + UA parser) + `server`
> (`auth.ts` only — no new package). Owner: TBD.
> Status: DRAFT (wave direction locked 2026-10-12, human Q&A).
> Depends on: existing `SessionStore` + session gate + settings page.
> Gate: approve before W8-01 (first code).

## 1. Objective

Close CAND-030: an Active Device Sessions card on Settings showing
every live session (browser, OS, IP, created, last-seen, THIS DEVICE
badge) with per-row Revoke and Log-Out-Others, backed by parsed-only
in-memory metadata captured at login and refreshed on each request.

Success: two logins from different UAs show two honest rows; revoking
the other kills exactly that session; tokens never appear in any
response; smoke proves the full lifecycle live.

## 2. API Contract (TypeScript)

```ts
// packages/auth/src/user-agent.ts (new, pure, zero deps)
export function parseUserAgent(ua: string): { browser: string; os: string };
//  e.g. Chrome/macOS, Firefox Mobile/Android, Safari/iOS, Edge/Windows,
//  empty/garbage -> { browser: 'Unknown', os: 'Unknown' }

// packages/auth/src/sessions.ts (additive)
export interface SessionMeta { browser: string; os: string; ip: string }
export interface SessionInfo extends SessionMeta {
  id: string; created: number; lastSeen: number; current: boolean;
}
export class SessionStore {
  create(meta: SessionMeta, now?: number): string;   // token (secret, 64-hex, unchanged)
  touch(token: unknown, meta: SessionMeta, now?: number): boolean;
  list(currentToken?: unknown, now?: number): SessionInfo[];  // tokens never included
  revokeById(id: string, currentToken?: unknown, now?: number): { revoked: boolean; self: boolean } | null; // null = unknown id
  revokeOthers(currentToken: unknown, now?: number): number;
  // validate/revoke/revokeAll/prune/size unchanged
}

// apps/server/src/auth.ts
// POST /api/login captures {browser, os} from User-Agent + ip from req.ip (X-Forwarded-For never trusted)
// preHandler: after validate passes -> store.touch(token, meta) (unconditional, in-memory, never throws)
// GET /api/auth/sessions -> { sessions: SessionInfo[] } (creation order)
// POST /api/auth/sessions/others/revoke -> { ok: true, revoked: n }
// POST /api/auth/sessions/:id/revoke -> { ok: true, self: boolean } (unknown id -> 404; self -> cookie cleared)
// POST /api/auth/logout-all unchanged
```

### Behavior

- Metadata is parsed-only (raw UA is parsed at the boundary and
  dropped — never stored, never logged) and memory-only (dies with
  the process and the hourly prune; no persistence, no new PII
  surface beyond what the admin's own browser already sends).
- Public ids are 8 random hex chars per session (unpredictable;
  brute force requires an already-authed attacker — documented,
  accepted). Tokens stay 64-hex secrets and never serialize.
- `list` lazy-prunes expired entries first (validate precedent), so
  the table never shows dead rows.
- `touch` refreshes lastSeen + IP only (creation browser/OS stay
  stable, so per-request UA variance never flickers rows and login
  method markers persist — refined W12-03, was full-meta refresh).
- Static `others/revoke` registers before parametric `:id/revoke`
  (store-wave lesson) + a test proving no `Unknown session` collision.
- Unknown-id revoke answers 404 (backup-schedule precedent, not the
  400 package-parity — rationale: sessions are addressed resources,
  and 404 leaks nothing past the auth gate).
- Self-revoke via crafted id still works at the endpoint (revokes +
  clears own cookie, `{self:true}`) — the BUTTON is what's hidden
  (mockup parity); defense in depth, documented.
- Frontend: Sessions card replaces ComingSoon CAND-030 — count badge,
  rows (browser + version?, OS, IP, created + relative last-seen,
  Active, THIS DEVICE badge on current, Revoke on others behind
  ConfirmDialog), "Log out other sessions" + dialog; new `fmtAgo`
  helper (`just now/5m/2h/Yesterday/3d`). After any revoke the list
  reloads; logout-all keeps its existing redirect.

## 3. Commands

```bash
Build: npm run build --workspace=@olp/auth && npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/auth && npm run test --workspace=@olp/server
Smoke: live double-login (distinct UA) -> list has 2 with current flags -> revoke other -> list has 1 -> unknown id 404 -> cleanup
```

## 4. Project Structure

```text
packages/auth/src/user-agent.ts             # hand parser (no new dep, per rules)
packages/auth/src/sessions.ts               # metadata + list/touch/revokeById/revokeOthers
packages/auth/src/index.ts                  # export additions
packages/auth/test/auth.test.ts             # + cases (extends file)
apps/server/src/auth.ts                     # capture/touch/endpoints (one domain file)
apps/server/test/auth-routes.test.ts        # + cases (extends file)
smoke/linux.mjs                             # + sessions checks
apps/web/src/lib/format.ts                  # fmtAgo (W8-04)
apps/web/src/pages/settings.tsx             # sessions card (W8-04)
```

## 5. Code Style

- Parser: ordered regex table (Edge before Chrome — Edg contains
  Chrome; OPR likewise), version = first dotted run after the brand
  token; mobile flag from `Mobile|Android|iPhone|iPad`.
- No `any`; English JSDoc; caps as named constants (8-hex id,
  200-char... n/a — parsed fields are parser-bounded, IPs from req).
- `touch` has no throw paths (invalid input → `false`).

## 6. Testing Strategy

- auth pkg (zero I/O): parser matrix (Chrome/macOS + version,
  Firefox-Mobile/Android, Safari/iPhone, Edge/Windows, empty,
  garbage, Edg-before-Chrome ordering proof); store metadata
  lifecycle (create/list/touch-refresh/revokeById/revokeOthers with
  fake `now`); serialized list contains no 64-hex token anywhere
  (JSON-stringify scan test).
- server (inject + fakes): login captures UA/IP (inject `headers`
  + `remoteAddress`); list shape + `current` flag per jar;
  touch advances lastSeen across requests; revoke-by-id (other +
  self-with-cookie-clear); others/revoke count; unknown id 404;
  static-beats-parametric proof; 401 gates.
- smoke (behavioral): two jars (curl `-A` distinct UA) → list length
  2, exactly one `current` per jar → revoke other → length 1 →
  revoked jar 401s → unknown id 404s.
- frontend: rows + THIS DEVICE without Revoke + revoke dialog flow +
  others flow + `fmtAgo` matrix + CAND-030 gone.

## 7. Boundaries

- Always: session gate on all four endpoints; tokens never
  serialized; `req.ip` only (never `X-Forwarded-For` — no trusted
  proxy in front of the panel); destructive revokes behind dialogs.
- Ask first: persisting sessions across restarts (kills the
  restart-invalidates security property); sliding expiry; per-IP
  allowlists.
- Never: expose tokens or password hashes in session responses;
  store raw UA; trust client-supplied identity claims.

## 8. Success Criteria

- [ ] auth + server builds green; inject suites green.
- [ ] Smoke sessions checks green live (two-jar lifecycle).
- [ ] Settings page wired; CAND-030 closed.
- [ ] Existing auth behavior diff-empty (login/logout/me/
  change-user/change-pass/logout-all untouched).

## 9. Open Questions

- Remember-me 30d + bind controls + verified badge stay CAND-031
  (separate design; this wave adds no TTL option).
- Native-app clients (Termux API webview UA) parse as generic
  browser until evidence lands — parser table grows with real UAs.

## 10. Decisions (locked 2026-10-12, human Q&A)

- Parsed-only memory-only metadata (raw UA dropped at the boundary;
  no persistence).
- No self Revoke button (mockup parity); endpoint still handles
  crafted self-revoke honestly (`self:true` + cookie clear).

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Device rows (browser+ver, THIS DEVICE, IP • OS • ago, Active) | sessions list (parsed UA, req.ip, created/lastSeen + fmtAgo) |
| Per-row Revoke | revoke-by-id + ConfirmDialog (hidden on current) |
| Log Out Other Sessions | others/revoke + dialog |
| Revoke All & Purge Cookies | existing logout-all (untouched, client already redirects) |
| Rotating CSRF tokens line | OUT — no CSRF mechanism exists; text not reproduced (honest drop, noted) |
| Zero-trust digest line | OUT — marketing copy, no mechanism (honest drop, noted) |
