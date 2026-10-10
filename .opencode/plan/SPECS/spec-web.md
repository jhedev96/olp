# SPEC — web

> Module id: `web` (`apps/web`: Vite + TypeScript SPA).
> Owner: TBD. Status: DRAFT.
> Depends on: server API surface (locked, audited), `/term` WS protocol
> (locked). No new runtime deps beyond npm-managed vendor libs.
> Gate: approve before any page is built (anti-spaghetti contract).

## 1. Objective

Rewrite the Terwo frontend (`terwo/public/`: 404-line `app.html` shell +
1124-line `app.js` + 71-line `login.html`, vanilla JS, vendored
`lucide`/`xterm`, committed Tailwind build output) as a typed Vite SPA
that preserves every slug, flow, and safety behavior, with vendor code
managed via npm instead of `public/vendor/`.

Success: all 10 slugs work against the OLP API with zero `.html`
navigations; 401 always lands on `/login`; user content is escaped;
the terminal drives xterm over `/term`; no CDN at runtime.

## 2. API Contract (TypeScript)

```ts
// apps/web/src/lib/api.ts
export class ApiError extends Error { status: number }
export async function api(path: string, opts?: RequestInit): Promise<Response>; // 401 → redirect /login + throw
export async function apiJson<T>(path: string, opts?: RequestInit): Promise<T>; // parses JSON, ApiError carries status
export function wsUrl(path: string): string; // http(s) → ws(s) + path

// apps/web/src/lib/format.ts
export function fmtSize(n: number): string;   // B/KB/MB/GB (Terwo parity)
export function fmtDate(ms: number): string;  // en-US locale (Terwo parity)
export function fmtUptime(sec: number): string;
export function esc(s: unknown): string;      // HTML-escape (XSSllis, Terwo parity)

// apps/web/src/lib/router.ts
export type Slug = 'login' | 'dashboard' | 'website' | 'database' | 'files' | 'cron' | 'backup' | 'settings' | 'terminal' | 'store';
export function slugFromPath(path: string): Slug; // unknown → 'dashboard' (authed) — Terwo tabFromPath parity
export function navigate(slug: Slug): void;       // pushState + render (no reload)

// apps/web/src/lib/theme.ts
export type Theme = 'dark' | 'light';
export function getTheme(): Theme;  // localStorage 'olp-theme', falls back to legacy 'terwo-theme', default dark
export function setTheme(t: Theme): void;
```

### Behavior

- Slugs (Terwo parity `panel.js:1418` + skeleton): `/login /dashboard
  /website /database /files /cron /backup /settings /terminal /store`.
  Unknown authed paths → dashboard; unauthenticated any → `/login`
  (server still enforces the gate — the SPA redirect is UX only).
- `api()` (Terwo `app.js:5` parity): `fetch` with same-origin cookies;
  on 401 redirect to `/login` and throw (prevents cascading renders);
  network errors surface per-page (never a blank screen).
- `esc()` on every user-controlled interpolation (filenames, site names,
  cron commands, log text) — the single XSS line of defense, unit-tested.
- Theme: dark default, toggle persisted; legacy `terwo-theme` migrated
  once (read-through, write-new-key).
- Dashboard polls `/api/stats` every 5 s (Terwo cadence); site-log views
  refresh manually; install logs poll while `running`.
- Terminal page: xterm.js + fit addon from npm (`xterm`,
  `@xterm/addon-fit`); right-click paste + paste button (mobile) + resize
  → `{t:'rs'}`; buttons for connect + `{t:'new'}` + clear; raw keystrokes
  written through; pipe-mode banner shows a degraded badge (server
  announces mode in the greeting — parse `, pipe)`).
- Vendor via npm, bundled by Vite: `lucide` (`createIcons()` after every
  render, Terwo `refreshIcons` parity), xterm CSS imported from the
  package. No `public/vendor/` directory, no CDN, no committed build
  output (`dist/` gitignored).
- Tailwind v4 via `@tailwindcss/vite` from the existing `input.css`
  source (devDep `tailwindcss` + plugin; drop `@tailwindcss/cli` +
  committed `tailwind.css`).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/web
Test:  npm run test --workspace=@olp/web
Dev:   npm run dev --workspace=@olp/web  # + server on :8080 (Vite proxy /api + /term)
```

## 4. Project Structure

```text
apps/web/src/
  main.ts                 # boot: theme, router, first render
  lib/api.ts lib/format.ts lib/router.ts lib/theme.ts
  pages/login.ts pages/dashboard.ts pages/files.ts pages/terminal.ts
  pages/sites.ts pages/database.ts pages/store.ts pages/cron.ts
  pages/backup.ts pages/settings.ts   # + nginx section inside sites.ts
  styles/input.css        # Tailwind source (moved from public/)
test/                     # mirror of src for unit tests (format, router, api, theme)
```

## 5. Code Style

```ts
// Good: typed page modules with explicit mount/unmount (pollers cleaned up).
export interface Page { mount(root: HTMLElement): void; unmount(): void }
export function DashboardPage(): Page { /* fetches /api/stats, 5 s poll, clears on unmount */ }
```

- No `any`; no direct `fetch` outside `lib/api.ts`; no `innerHTML`
  without `esc()` on interpolated data (grep-enforceable in review);
  English comments/JSDoc.

## 6. Testing Strategy

- Framework: Vitest (devDep, jsdom-free — pure logic only; DOM pages
  tested via injected fakes where cheap, else manual smoke).
- Cases: format vectors (B/KB/MB/GB boundaries, en-US date, uptime);
  router slug mapping + unknown fallback; api wrapper 401-redirect +
  JSON parse + network-error passthrough (mocked `fetch`); theme
  read-through/migration/persist (mocked `localStorage`); terminal
  message builders (`{t:'in'|'rs'|'new'}` shapes); xterm message parser
  (pipe badge detection).
- Browser E2E deferred per ADR-003 (Playwright, Phase 4, Linux CI only).
  Until then: manual smoke checklist per page against a live server.

## 7. Boundaries

- Always: escape user content; clean up pollers/sockets on unmount;
  keep slugs stable (bookmarks + audit parity).
- Ask first: new slugs; new npm vendor deps; breaking the `api()` 401
  contract; dropping any Terwo UI capability.
- Never: inline `onclick` handlers with interpolated data (XSS);
  commit `dist/`; exposetokens (none client-side — HttpOnly cookies).

## 8. Success Criteria

- [ ] All 10 slugs render against live OLP API with zero console errors.
- [ ] 401 mid-session lands on `/login`; theme + slugs survive reload.
- [ ] Terminal works in pty and pipe modes (badge in pipe).
- [ ] `npm run build` output serves from any static host with API proxy.

## 9. Open Questions

- Page implementation order — proposal: login → dashboard → files →
  terminal → sites(+nginx) → database → store → cron → backup → settings
  (each page its own task series; settings last as it touches auth state).
- Dev proxy: Vite `server.proxy` for `/api` + `/term` (ws:true) to
  `http://127.0.0.1:8080` — confirm port convention.

## 10. Decisions

- Vanilla TS, no framework (parity with Terwo's dependency-free UI;
  revisit only with measured pain).
- `lucide` + `xterm` via npm (kill `public/vendor/`).

## 11. Parity mapping (§9.2)

| Terwo (`public/`) | OLP | Mark |
|---|---|---|
| `api()` 401→login `app.js:5` | `lib/api.ts` same | parity |
| `fmtSize/fmtDate/fmtUptime/esc` `:10-28` | `lib/format.ts` same | parity |
| `tabFromPath/showTab/popstate` `:73-94` + slugs | `lib/router.ts` same 9 slugs + login | parity |
| `refreshIcons/ic/dot` `:30-42` | lucide npm, same refresh-after-render | parity |
| theme `terwo-theme` `:43` | `olp-theme` + legacy read-through | deviation (rebrand, compat) |
| xterm + WS `t:in/rs/new` | same protocol, npm xterm + fit addon | parity |
| 5 s stats poll, manual log refresh | same cadences | parity |
| committed `tailwind.css` + vendor/ | Vite build, npm vendor, `dist/` ignored | deviation (toolchain) |
