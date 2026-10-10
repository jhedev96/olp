# SPEC — auth

> Module id: `auth`. Owner: TBD. Status: DRAFT.
> Depends on: none (pure `node:crypto` + injected fs). Gate: approve before login/settings routes are ported.

## 1. Objective

Own all authentication semantics preserved from Terwo (`terwo/panel.js` login gate, PBKDF2 password hashing, `tpsid` session cookie, config persistence + first-run generation, `~/.termux-panel` → `~/.olp` migration) as pure, injectable units, so Fastify routes become thin wrappers with zero crypto inline.

Success: `apps/server` login/logout/gate/change-username/change-password handlers import only from `@olp/auth`; no `crypto.pbkdf2Sync` or `sessions Map` remains in route code.

## 2. API Contract (TypeScript)

```ts
// packages/auth/src/password.ts
export function hashPassword(password: string, salt: string): string; // pbkdf2Sync 120k/32/sha256 hex
export function verifyPassword(password: string, salt: string, expectedHash: string): boolean;
export function generateSalt(): string;      // 16 bytes hex
export function generateUsername(): string;  // 8 chars, alphabet 'abcdefghjkmnpqrstuvwxyz23456789'
export function generatePassword(): string;  // 12 bytes base64url
export function validUsername(u: unknown): boolean; // /^[a-zA-Z0-9_-]{3,32}$/
export function validateNewPassword(pw: unknown, confirm?: unknown): string | null; // error or null

// packages/auth/src/config.ts
export interface AuthConfig { username: string; salt: string; hash: string }
export interface LoadResult { config: AuthConfig; created: boolean; migrated: boolean; plaintextPassword?: string }
export function loadConfig(dataDir: string, opts?: ConfigIo): LoadResult;
export function saveConfig(dataDir: string, config: AuthConfig, opts?: ConfigIo): void;
export function verifyCredentials(username: unknown, password: unknown, config: AuthConfig): boolean;
export function changeUsername(config: AuthConfig, username: unknown): { config: AuthConfig } | { error: string };
export function changePassword(config: AuthConfig, current: unknown, next: unknown, confirm: unknown): { config: AuthConfig } | { error: string };

// packages/auth/src/sessions.ts
export const SESSION_TTL_MS = 86400 * 1000;
export class SessionStore {
  create(now?: number): string;       // 32 bytes hex token
  validate(token: unknown, now?: number): boolean; // false + lazy-delete on expiry
  revoke(token: unknown): void;
  revokeAll(): void;
  prune(now?: number): number;        // returns removed count
  readonly size: number;
}

// packages/auth/src/cookies.ts
export const COOKIE_NAME = 'tpsid';
export function parseCookies(header: string | undefined): Record<string, string>;
export function loginCookie(token: string): string;  // 'tpsid=..; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400'
export function clearCookie(): string;               // expired tpsid cookie
export function sessionTokenFromHeader(header: string | undefined): string | undefined;
```

### Behavior

- Hash compat: identical algorithm/params to Terwo (`terwo/panel.js:44-46`); existing `config.json` hashes verify unchanged. Empty password never verifies (guard before hashing).
- Username compare is timing-safe; password compare hashes then compares (same as Terwo `panel.js:1436-1449`). Login error is generic (`Invalid username or password`, English — legacy Indonesian message translated at port time).
- `loadConfig()`: `mkdir -p dataDir`; if `dataDir/config.json` exists → parse (legacy quirk preserved: missing `username` defaults to `'admin'`); else if `legacyDir/config.json` exists → copy bytes to `dataDir` with mode `0600`, `migrated:true`; else generate `{username, salt, hash}` with fresh randoms, write `0600`, return `plaintextPassword` once (caller displays it; never persisted). `created:true` when generated.
- Config file mode is always `0600` (read/write owner only). `saveConfig` overwrites atomically enough for single-admin use (write file, chmod 0600).
- `SessionStore`: absolute TTL from `created` (no sliding); `validate` lazy-deletes expired tokens; `prune` is also called by the server on an hourly timer (server owns the timer, not this package).
- `changePassword` rules (Terwo parity): current must verify; new min 6 chars; `next === confirm`; on success returns new config with fresh salt (caller must `saveConfig` + `revokeAll`, forcing re-login everywhere).
- `changeUsername` rules: `validUsername`, returns updated config (caller saves; sessions stay valid, matching Terwo).
- Cookie flags byte-identical to Terwo (`panel.js:1445,1472`): `HttpOnly; Path=/; SameSite=Lax; Max-Age=86400` on login, `Max-Age=0` clear on logout.

## 3. Commands

```bash
Build: npm run build --workspace=@olp/auth
Test:  npm run test --workspace=@olp/auth
Lint:  eslint packages/auth --max-warnings=0
```

## 4. Project Structure

```text
packages/auth/
  src/password.ts
  src/config.ts
  src/sessions.ts
  src/cookies.ts
  src/index.ts
  test/auth.test.ts
```

## 5. Code Style

```ts
// Good: pure + injectable fs, English JSDoc, no process.env.
export interface ConfigIo {
  mkdirp?: (dir: string) => void;
  readFile?: (path: string) => string | null;
  writeFile?: (path: string, data: string) => void;
}
export function loadConfig(dataDir: string, opts: ConfigIo = {}): LoadResult { /* ... */ }
```

- No `any`. `unknown` inputs for all user-supplied values (usernames, passwords, tokens, cookie headers).
- `node:crypto` only inside `password.ts` + `sessions.ts` (token gen).

## 6. Testing Strategy

- Framework: Vitest. No real fs (inject `ConfigIo` fakes); real `node:crypto` (fast enough: single pbkdf2 ≈ tens of ms; keep vector count small).
- Cases: known PBKDF2 vector verifies + wrong password rejects + empty rejects; username regex edges; `loadConfig` existing/missing-username-default/migrated-from-legacy/generated (plaintext returned once, file mode asserted via fake); save preserves shape; `verifyCredentials` ok/bad-user/bad-pass; changeUsername valid/invalid; changePassword wrong-current/short/mismatch/ok-returns-fresh-salt; sessions create→validate→expiry→prune→revoke→revokeAll; cookies parse/serialize/clear round-trip.
- Coverage: 100% branches on `validateNewPassword`, `changePassword`, session expiry paths.

## 7. Boundaries

- Always: `0600` on config writes; timing-safe username compare; generic login errors (no user enumeration); English messages.
- Ask first: changing hash params (breaks existing logins — needs upgrade path); adding session persistence across restarts (currently in-memory by design).
- Never: log passwords/hashes/tokens; read `process.env` (paths are parameters); start timers (server owns lifecycle).

## 8. Success Criteria

- [ ] `npm run build --workspace=@olp/auth` + `vitest run` green.
- [ ] Login/logout/change-username/change-password routes portable to thin wrappers (no crypto left in routes).
- [ ] Migration `~/.termux-panel` → `~/.olp` covered by test.

## 9. Open Questions

- Argon2id upgrade timing (tracked in PLAN open research; v2.0 stays PBKDF2 — confirm).
- Session persistence across restarts: keep in-memory (Terwo parity, forces re-login on restart — confirm).

## 10. Decisions

- None yet.
