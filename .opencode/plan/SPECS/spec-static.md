# SPEC — static

> Module id: `static` (part of `@olp/server`: SPA hosting + landing).
> Owner: TBD. Status: DRAFT (backfilled alongside implementation — the gap
> only became visible once all 10 slugs existed).
> Depends on: auth gate (locked), `@fastify/static` (runtime dep).
> Gate: approve before OLP serves its own UI.

## 1. Objective

Make OLP runnable end-to-end from one process: serve the built Vite app
(`apps/web/dist`) with client-side-slug fallback, plus the `/` landing
redirect, while keeping every `/api/*` miss a JSON 404. Without this the
panel only works behind the Vite dev proxy.

Success: fresh login → dashboard flow against one origin; unknown slugs
boot the SPA; unknown API paths stay JSON; missing `dist/` degrades to
API-only instead of crashing boot.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/static.ts
export interface StaticOptions { distDir?: string; validate: (cookieHeader: string | undefined) => boolean }
export function resolveDistDir(fromUrl?: string): string | undefined; // OLP_WEB_DIR → sibling dist → undefined
export function registerStaticRoutes(app: FastifyInstance, opts: StaticOptions): void;
// GET / → 302 /dashboard (authed) | /login (else)
```

### Behavior

- `GET /` answers 302 (`/dashboard` with a valid session, else `/login` —
  Terwo `/` parity).
- `distDir` resolution: explicit `OLP_WEB_DIR` wins; else the sibling
  `apps/web/dist` (same relative depth from `src/` and `dist/`, so dev
  and prod agree); missing `index.html` → `undefined` (API-only mode,
  boot never fails for a missing frontend build).
- Static files served at `/` with dotfiles denied; unknown non-API paths
  fall back to `index.html` (history-API slugs); unknown `/api/*` paths
  answer JSON 404 (existing explicit 404s untouched — the fallback only
  fires on no-match).
- `ServerOptions.webDir?: string | null`: `null` forces API-only (tests),
  `undefined` resolves (production default).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
apps/server/src/static.ts
apps/server/test/static-routes.test.ts  # temp dist dir (no real build needed)
```

## 5. Code Style

- JSDoc on all exports (English); no `process.env` reads outside
  `resolveDistDir`.

## 6. Testing Strategy

- Framework: Vitest, Fastify `inject()`, tempdir `dist/` (hand-written
  `index.html` + asset — never the real build).
- Cases: `/` redirects by session; asset served with content-type;
  unknown slug serves `index.html`; unknown `/api/*` stays JSON 404;
  `resolveDistDir` override/missing/index-less branches; API-only mode
  leaves `/` redirect working.

## 7. Boundaries

- Always: dotfiles denied; API 404s stay JSON; never crash on missing dist.
- Ask first: cache headers tuning; serving uploads/backups as static.
- Never: serve outside `distDir`; expose `node_modules`.

## 8. Success Criteria

- [ ] One-origin login → dashboard flow against a live server + real build.
- [ ] `npm run build` (root) then `node apps/server/dist/index.js` serves UI.

## 9. Open Questions

- None open for v1 port.

## 10. Decisions

- `@fastify/static` over hand-rolled streaming (etag/range/caching free).
- Spec backfilled with implementation (gap found post-hoc; recorded here).

## 11. Parity mapping (§9.2)

| Terwo (`panel.js`/`public/`) | OLP | Mark |
|---|---|---|
| `/` → 302 dashboard/login | same | parity |
| static `servePublic` per file | `@fastify/static` + SPA fallback | deviation (toolchain; slugs need fallback) |
| API 404 shapes | preserved (fallback is no-match-only) | parity |
