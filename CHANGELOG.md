# Changelog — OpenLocalPanel (OLP)

All notable changes, newest first. Versioning: `2.0.0-alpha.x` until the
v2.0.0 release cut.

## [Unreleased]

### Added

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
