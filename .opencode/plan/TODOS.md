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
- [x] Create `jhedev96/olp` via `gh repo create` (done 2026-10-10, public)
- [x] Add remote + push `main` (done 2026-10-10, tracking `origin/main`)
- [x] Live smoke Debian-class (2026-10-10, proot Ubuntu box: fresh clone →
  `npm ci` → ordered build → `prune` → boot → `smoke/linux.mjs` 27/27
  green incl. jail escapes denied + real pipe WS echo; caught 2 real bugs:
  unordered workspace builds, `resolveDistDir` off-by-one)
- [ ] Live smoke Termux (installer, login, files, terminal, boot story)
- [ ] Live smoke native Debian VPS (systemd unit via `olp install`)
- [x] Fill release version (bump off `2.0.0-alpha.0`), tag, GitHub release
  (`v2.0.0-alpha.1` tagged + released 2026-10-10, prerelease flag on)
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

## Phase 11 — Monitor wave 1 (read-only telemetry, approved 2026-10-12)

- [x] W1-00 planning: spec + tasks + todos (`SPECS/spec-monitor-wave.md`, `TASKS/phase-11-monitor-wave.md`)
- [x] W1-01 sysinfo monitor providers
- [x] W1-02 server monitor routes
- [x] W1-03 smoke extension + live PASS/FAIL
- [x] W1-04 frontend monitor wiring
- [x] W1-05 docs + CAND-001/002/003/014 close-out (CAND-004 kill deferred by decision)

## Phase 12 — Kill wave 2 (privileged kill, spec approved 2026-10-12)

- [x] W2-00 planning: spec + tasks + todos (`SPECS/spec-kill-wave.md`, `TASKS/phase-12-kill-wave.md`)
- [x] W2-01 sysinfo kill helper + verdict tests
- [x] W2-02 server kill route + inject tests
- [x] W2-03 smoke extension + live ALL GREEN
- [x] W2-04 frontend per-row Kill wiring
- [x] W2-05 docs + CAND-004 close-out

## Phase 13 — Daemon wave 3 (Services & Daemons, spec approved 2026-10-12)

- [x] W3-00 planning: spec + tasks + todos (`SPECS/spec-daemon-wave.md`, `TASKS/phase-13-daemon-wave.md`)
- [x] W3-01 sysinfo daemon presence + tests
- [x] W3-02 server services routes + inject tests
- [x] W3-03 smoke extension + live ALL GREEN
- [x] W3-04 dashboard section wiring
- [x] W3-05 docs + CAND-005 close-out

## Phase 14 — Database wave 4 (create + schema info, spec approved 2026-10-12)

- [x] W4-00 planning: spec + tasks + todos (`SPECS/spec-database-wave.md`, `TASKS/phase-14-database-wave.md`)
- [x] W4-01 driver methods (create/stats/def ×2 engines)
- [x] W4-02 routes + fake-driver inject tests
- [x] W4-03 frontend (dialog, badges, DDL modal, panel)
- [x] W4-04 docs + CAND-006/026 close-out
- [ ] HUMAN GATE (before release): New Database + schema browser against real MariaDB + PostgreSQL

## Phase 15 — Cron insights wave 5 (dry-run, run-now, stats, spec approved 2026-10-12)

- [x] W5-00 planning: spec + tasks + todos (`SPECS/spec-cron-wave.md`, `TASKS/phase-15-cron-wave.md`)
- [x] W5-01 schedule parser + run store + tests
- [x] W5-02 backend runCommand + routes + inject tests
- [x] W5-03 smoke extension + live ALL GREEN
- [x] W5-04 frontend wiring
- [x] W5-05 docs + CAND-028 close-out

## Phase 16 — Backup advanced wave 6 (verify, gzip, upload, schedules; spec approved 2026-10-12)

- [x] W6-00 planning: spec + tasks + todos (`SPECS/spec-backup-wave.md`, `TASKS/phase-16-backup-wave.md`)
- [x] W6-01 sha256 sidecar + verify endpoint + tests
- [x] W6-02 gzip dump variant + tests
- [x] W6-03 upload import + tests
- [x] W6-04 schedules CRUD + ticker + tests
- [x] W6-05 smoke extension + live ALL GREEN
- [x] W6-06 frontend wiring
- [x] W6-07 docs + CAND-029 close + CAND-035 open

## Phase 17 — Store extras wave 7 (versions, update/upgrade, conf, mirror; spec approved 2026-10-12)

- [x] W7-00 planning: spec + tasks + todos (`SPECS/spec-store-wave.md`, `TASKS/phase-17-store-wave.md`)
- [x] W7-01 pkgman versionCmd/conf + manager commands + tests
- [x] W7-02 server versions/update/upgrade/mirror + tests
- [x] W7-03 smoke extension + live ALL GREEN
- [x] W7-04 frontend wiring
- [x] W7-05 docs + CAND-027 close + CAND-036 open

## Phase 18 — Device sessions wave 8 (list, revoke, logout-others; spec approved 2026-10-12)

- [x] W8-00 planning: spec + tasks + todos (`SPECS/spec-sessions-wave.md`, `TASKS/phase-18-sessions-wave.md`)
- [x] W8-01 auth UA parser + session metadata + tests
- [x] W8-02 server capture/touch/endpoints + tests
- [x] W8-03 smoke extension + live ALL GREEN
- [x] W8-04 frontend wiring
- [x] W8-05 docs + CAND-030 close

## Phase 19 — Server config wave 9 (remember-me, badge, bind, drop; spec approved 2026-10-12)

- [x] W9-00 planning: spec + tasks + todos (`SPECS/spec-server-config-wave.md`, `TASKS/phase-19-server-config-wave.md`)
- [x] W9-01 auth per-session TTL + cookie age + tests
- [x] W9-02 server remember/getMe/bind/identity + tests
- [x] W9-03 smoke extension + live ALL GREEN
- [x] W9-04 frontend wiring
- [x] W9-05 docs + CAND-031 close + CAND-037 open

## Phase 20 — Editor prettify + diff wave 10 (client-side; spec + ADR-006 approved 2026-10-12)

- [x] W10-00 planning: spec + ADR-006 + tasks + todos (`SPECS/spec-editor-wave.md`, `docs/adr-006-editor-format-diff.md`, `TASKS/phase-20-editor-wave.md`)
- [x] W10-01 prettier + format-code + line-diff + unit tests
- [x] W10-02 files toolbar + diff panel + page tests
- [x] W10-03 docs + CAND-033 close
