# PRD — OpenLocalPanel (OLP)

> Evolution of Terwo (Termux Web Operation) into a multi-environment local operations panel.
> Status: DRAFT skeleton v0.1. Source of truth for scope. Details move to `SPECS/` once locked.
> Language: English only (per `PROJECT_RULES.md`).

## 1. Background

Terwo v1.13.0 is a single-file Node.js panel (`terwo/panel.js`, ~1682 LOC, vanilla `http` + `ws`) serving: file manager, terminal (xterm.js + optional `node-pty`), system info, website hosting (Node/PHP/static/Go), Nginx reverse proxy GUI, MySQL/PostgreSQL manager, Store (Termux `pkg` installs), Cron, Backup, Settings, Telegram notifications/bot.

Constraints of the current implementation:

- Monolith: auth, routes, exec helpers, all domains in one file. Hard to maintain, test, or extend.
- Termux-only assumptions hardcoded: `PREFIX=/data/data/com.termux/files/usr`, `pkg install`, `SHELL` fallback, Termux:API battery path, no `systemctl` (`terwo/README.md`, `terwo/install.sh`).
- Frontend is static `terwo/public/` (`app.html`, `app.js` ~49KB, `login.html`) with built Tailwind output committed. No build isolation, no type safety.
- No abstraction for OS, package manager, or service manager. Porting means sprinkling `if` branches.

## 2. Vision

**OpenLocalPanel (OLP)**: a lightweight, offline-first, self-hosted web operations panel that runs natively on Termux, major Linux distros, macOS, and Windows, with a modular codebase that is easy to maintain and extend.

Rebrand: `terwo` -> `olp`. Binary `olp`, package `@olp/panel`, config dir `~/.olp` (migration from `~/.termux-panel` required).

## 3. Goals

1. Preserve 100% of Terwo v1.13.0 feature parity on Termux after migration.
2. Break the monolith into a typed monorepo with clear module boundaries.
3. Support multiple environments through a single `env-core` abstraction (no per-feature OS branching).
4. Ship a Vite-built frontend (`apps/web`) decoupled from the Fastify API (`apps/server`).
5. Provide native installers per environment plus a unified `olp` CLI.
6. Enforce maintainability gates: TypeScript strict, lint, test, 1 task = 1 commit.

## 4. Non-Goals (v2 scope cut)

- Full native Windows support in v2.0 (tracked as follow-up plan; WSL2 is the Windows path for v2.0).
- Multi-user / RBAC / organizations. Single admin user only, same as Terwo.
- Public-internet exposure hardening beyond current model (localhost-by-default + LAN opt-in, strong password warning). No built-in ACME/HTTPS in v2.0.
- Docker/Kubernetes orchestration UI. Process-level hosting only.
- Mobile native apps.

## 5. Users

- Primary: solo developer / homelab owner running side projects on a phone (Termux), VPS, or laptop.
- Secondary: contributor extending OLP with a new package adapter or site runtime.

## 6. Environment Support Matrix (v2.0)

| Environment | Detection key | Package manager | Service manager | Priority |
|---|---|---|---|---|
| Termux (Android) | `termux` | `pkg` | `pm2` + Termux:Boot | P0 (parity) |
| Debian / Ubuntu | `debian` | `apt` | `systemd` | P0 |
| Arch / Manjaro | `arch` | `pacman` | `systemd` | P1 |
| Alpine | `alpine` | `apk` | `openrc` | P1 (explicitly in scope) |
| Fedora / RHEL | `fedora` / `rhel` | `dnf` (`yum` fallback) | `systemd` | P1 |
| macOS | `macos` | `brew` | `launchd` | P2 |
| Windows (WSL2) | `wsl2` | distro passthrough | distro passthrough | P2 |
| Windows native | `windows` | `winget` (+ `choco`/`scoop` fallback, research) | `sc.exe` / Task Scheduler (research) | P3 (separate plan) |

Locked decisions: `systemd` + `openrc` both covered in v2.0. Windows native is deferred to a later plan.

## 7. Functional Requirements (parity + deltas)

Each item gets a dedicated spec in `SPECS/spec-<id>.md` before implementation.

1. **Auth & settings** — PBKDF2 retained initially, upgrade path to argon2 documented; HttpOnly session cookie; 24h TTL; change username/password; logout-all. Config migration `~/.termux-panel` -> `~/.olp`.
2. **Dashboard / sysinfo** — CPU, RAM, disk, uptime, website status; battery via adapter (Termux:API on Termux, IOKit/UPower/WMI elsewhere, graceful `unavailable` fallback). 5s polling retained.
3. **File manager** — scoped to `PANEL_ROOT`; browse/upload/download/mkdir/touch/rename/delete/edit (1 MB cap retained initially)/zip/unzip/image preview. 50 MB upload cap retained initially.
4. **Terminal** — xterm.js; `node-pty` when available, pipe-mode fallback. Right-click paste, mobile paste button, resize.
5. **Sites** — Node (`node <file>`, `PORT` injected), PHP (`php -S`), static (`python3 -m http.server`), Go (`go run .`); start/stop/restart/logs (300-line ring retained initially); port-collision guard.
6. **Reverse proxy** — Nginx GUI: add/remove proxy, `nginx -t` gate, reload; Termux path vs `/etc/nginx` abstraction.
7. **Database** — MySQL/MariaDB + PostgreSQL: test/save/connect, browse DBs/tables, 50-row preview, ad-hoc SQL (20k char cap retained initially).
8. **Store** — 1-click installs with live log streaming. Command table becomes per-OS data (`pkgman` package), not a hardcoded Termux list.
9. **Cron/scheduler** — `crond` (Termux/cronie), `crontab` on Linux/macOS, Task Scheduler research on Windows native.
10. **Backup** — folder zip + DB dump; download/restore/delete.
11. **Telegram** — finish notifications + `/help /status /ram /cpu /battery /sites` polling bot, chat-ID allowlist.
12. **CLI & installer** — `olp install|start|status|logs`; per-OS one-line installers replacing Termux-only `install.sh`.

## 8. Non-Functional Requirements

- **Maintainability**: TypeScript strict, Fastify server, Vite frontend, ESLint + Prettier, per-package unit tests. No new file > ~400 LOC without justification.
- **Offline-first**: no CDN at runtime. Vendor assets (`lucide`, `xterm.js`) stay local, managed via npm + Vite bundle.
- **Security**: localhost bind by default; `0.0.0.0` explicit opt-in with warning; `PANEL_ROOT` jail; input validation (`safePath`/`safeName` semantics preserved); no secrets in logs; file perms `0600` for config.
- **Performance**: dashboard payload < 50 KB; API p95 < 200 ms on low-end device (excluding exec polling); frontend LCP < 2.5s on LAN.
- **Compatibility**: Node.js baseline TBD (see Open Questions — research active). Initial proposal to validate: Node 20 LTS minimum.

## 9. Success Metrics (v2.0 exit criteria)

- `panel.js` fully strangler-migrated; no runtime import from legacy file.
- All P0 + P1 environments install, start, and pass smoke suite (auth, files, terminal, sites, store-dry-run, sysinfo).
- `npm run build && npm run test && npm run lint` green on CI for Node baseline x OS matrix.
- Docs: README quickstart per OS, migration guide Termux -> OLP.

## 10. Risks

- `node-pty` compilation failures on Alpine/Windows/macOS -> retain pipe-mode fallback, mark degraded.
- Package-name drift across distros (`mariadb` vs `mysql`, `cronie` vs `cron`) -> data-driven `pkgman` catalog + CI check.
- Permission models (ports < 1024, service install needs sudo) -> fail-closed with actionable message.
- Scope creep into Windows-native -> contained by deferring to separate plan.

## 11. Open Questions (all must resolve to a spec before build)

1. Node.js minimum version (proposal: 20 LTS) — pending research on distro-packaged Node versions and `node-pty` support. Owner: TBD.
2. Windows-native package manager choice (`winget` vs `choco` vs `scoop`) and service model — deferred to Windows-native plan, but interface in `env-core` must not preclude it.
3. Auth upgrade: stay PBKDF2 (120k iterations) for v2.0 or move to argon2id now?
4. Frontend router: Vite + minimal router vs single `app.html` port? Proposal: Vite SPA with `/login /dashboard /website /database /files /cron /backup /settings /terminal /store` slugs preserved.
5. Nginx vs Caddy as default reverse proxy on non-Termux? Proposal: keep Nginx GUI, evaluate Caddy later.
6. Telemetry: strictly none (keep Terwo posture) — confirm.

## 12. Spec Index (to be created)

- `SPECS/spec-env-core.md` — detection + `Environment` interface.
- `SPECS/spec-pkgman.md` — per-OS command catalog.
- `SPECS/spec-services.md` — systemd/openrc/launchd/pm2 adapters.
- `SPECS/spec-auth.md`, `spec-files.md`, `spec-terminal.md`, `spec-sites.md`, `spec-proxy.md`, `spec-database.md`, `spec-store.md`, `spec-cron.md`, `spec-backup.md`, `spec-telegram.md`, `spec-cli.md`, `spec-web.md`.
