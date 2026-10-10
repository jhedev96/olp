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

- [ ] Migration tool + per-OS docs + changelog + tag
