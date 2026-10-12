# Changelog — OpenLocalPanel (OLP)

All notable changes, newest first. Versioning: `2.0.0-alpha.x` until the
v2.0.0 release cut.

## [v2.0.0-alpha.1] — 2026-10-10 ([release notes](https://github.com/jhedev96/olp/releases/tag/v2.0.0-alpha.1))

First public alpha: full Terwo surface parity (see route audit in
`.opencode/plan/TODOS.md`), 258 tests green, Debian-class live smoke
27/27, per-OS installers, `olp` CLI. Needs on-device verification on
Termux/Alpine/macOS hardware.

## [Unreleased]

### Added

- Monitor wave 1 (read-only): `GET /api/monitor/summary` (per-core
  CPU %, temp, freq, model/kernel/arch, swap detail, disk I/O rates,
  network interfaces + listening ports, battery) and
  `GET /api/monitor/processes` (top-by-RSS with CPU shares, best-effort
  PM2 rows); `/monitor` page wired (per-core bars, net spark from
  polled rates, proc table, conditional PM2). Kill stays out (deferred
  authz wave, CAND-004). Smoke 28/28 on Linux.
- Kill wave 2: `POST /api/monitor/processes/:pid/kill` (TERM default,
  KILL opt-in) under deny-by-default authz (never init/self/other
  users' processes as non-root; every decision audit-logged); per-row
  Kill behind ConfirmDialog. Smoke 32/32 on Linux.

- Fastify API server (auth, files, terminal WS, sites, proxy, database,
  store, cron, backup, settings, telegram, watchdog, static SPA hosting).
- React + Vite + Tailwind SPA (10/10 slugs: login → settings).
- Packages: `auth`, `env-core`, `sysinfo`, `pkgman` (26-item catalog),
  `services` (systemd/openrc/launchd/pm2).
- `olp` CLI (`install|start|stop|restart|status|logs`, `--dry-run`).
- Per-OS installers: termux, debian, arch, alpine, fedora, macos.
- Docs: PRD/PLAN/specs/ADRs under `.opencode/plan/` and `docs/`.
- 254 tests green (Vitest, zero real services in unit suites).

### Changed

- Rebrand Terwo → OpenLocalPanel; config dir `~/.termux-panel` →
  `~/.olp` (auto-migrated on first boot); UI messages English.
- Monolith `panel.js` split into typed workspaces (TypeScript strict).

## [1.x] — Terwo era (upstream)

- See the [Terwo repository](https://github.com/elkom14a/terwo) history.
  OLP v2 preserves its full `/api/*` + `/term` surface (see route audit
  in `.opencode/plan/TODOS.md`).
