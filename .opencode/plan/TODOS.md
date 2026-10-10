# TODOS — OpenLocalPanel (OLP)

> Running checklist. Single source for "what is next". Updated per task completion.
> Detailed tasks live in `TASKS/`. Contracts live in `SPECS/`.

##Legend
- `[ ]` pending, `[~]` in progress, `[x]` done (with commit hash).

## Phase 0 — Discovery & Research

- [x] Init OLP repo root (`d2f82ee`)
- [x] Add PRD skeleton (`2e235a4`)
- [x] Add PLAN skeleton (`3dd5fd1`)
- [x] Add PROJECT_RULES (`1d8884d`)
- [ ] Add TODOS running checklist (this file)
- [ ] Add TASKS phase-00 discovery breakdown
- [ ] Add SPEC env-core (detection + interface)
- [ ] Add AGENTS definition
- [ ] Inventory legacy `terwo/panel.js` routes and limits
- [ ] ADR-001: Node.js minimum version (candidate 20 LTS)
- [ ] ADR-002: npm vs pnpm workspaces
- [ ] Research per-OS package catalog (apt/pacman/apk/dnf/brew)

## Phase 1 — Foundation (not started)

- [ ] Scaffold monorepo (`apps/server`, `apps/web`, `packages/*`, `cli/`)
- [ ] TypeScript strict + ESLint + Prettier + Vitest + CI green
- [ ] Fastify healthz + Vite hello with Terwo slugs
- [ ] Rebrand constants (`~/.olp`, `olp` binary)

## Phase 2 — env-core + Libs (blocked until SPEC env-core approved)

- [ ] Implement `detect()` with fixture tests
- [ ] Port `safePath`/`safeName`/limits/exec env
- [ ] Auth package with migration `~/.termux-panel` -> `~/.olp`

## Phase 3 — Strangler Port (blocked until Phase 2 gate green)

- [ ] stats/sysinfo, auth/settings, files, terminal, sites, proxy, database, store, cron, backup, telegram (one series per domain)

## Phase 4 — Multi-OS Hardening

- [ ] pkgman catalog + services adapters (systemd/openrc/launchd/pm2)
- [ ] Smoke suite on P0+P1 matrix

## Phase 5 — Release v2.0.0

- [x] Full root verify green (2026-10-10: build exit 0, 258/258 tests —
  server 118, web 61, auth 21, env-core 20, sysinfo 15, pkgman 6,
  services 7, cli 10)
- [ ] Create `jhedev96/olp` via `gh repo create` (human: repo does not
  exist yet; `gh` authed as jhedev96, verified 2026-10-10)
- [ ] Add remote + push `main`
- [ ] Live smoke Termux (installer, login, files, terminal, boot story)
- [ ] Live smoke Debian (installer, systemd unit, login, stats)
- [ ] Fill release version (bump off `2.0.0-alpha.0`), tag, GitHub release
- [ ] Migration dry-run Terwo → OLP on a spare profile

## Route Audit — backend surface complete (2026-10-10)

> Method (§9.1): enumerated every `p === '…'` + `p.match(…)` route in
> `terwo/panel.js`, every `app.get/post/delete('…')` in `apps/server/src`,
> and every `/api/…` reference in `terwo/public/app.js` + `login.html`.
> Counts: Terwo 51 route registrations (incl. static pages), OLP 45 API
> routes + `/term` WS. Verdict: **48/48 UI-used endpoints ported.**

Ported (Terwo → OLP, same path+method): login, logout,
auth/change-username, auth/change-password, auth/logout-all, settings×2,
settings/test-telegram, stats, files, mkdir, touch, rename, delete, read,
write, upload, download, files/zip, files/unzip, files/preview,
sites×2 + :id/start|stop|restart|delete|logs, install + :id/start|log,
db/:engine×9 (mysql+postgres), nginx/status|service|proxies +
proxies/:id DELETE, cron/status|service|jobs×2 + jobs/:id/toggle|DELETE,
backups×2 + :name/download|restore|DELETE, `/term` WS. Plus OLP addition
`GET /api/me` (no Terwo counterpart, needed by the SPA).

Deliberate drops (all verified unused by `app.js` + `login.html`):
- `GET /api/sysinfo` — legacy snapshot superseded by `/api/stats` (the UI
  only ever called `/api/stats`).
- `POST /api/chpasswd` — legacy duplicate of `/api/auth/change-password`.
- `GET /api/battery/debug` — dev diagnostic, no UI caller (revisit as a
  dev tool if wanted).

Deferred to web scope: static pages (`/login`, `/app.html`, vendor assets)
— served by the Vite SPA in OLP, not the API server.

- [x] Backend surface audit (drops recorded above; no silent gaps).
