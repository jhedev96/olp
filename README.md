# OpenLocalPanel (OLP)

> **Open** local operations panel — file manager, terminal, website hosting,
> databases, cron, backups, and more, from your browser. Evolution of
> [Terwo](https://github.com/elkom14a/terwo) (Termux-only) into a
> multi-environment panel: Termux, Debian/Ubuntu, Arch, Alpine, Fedora/RHEL,
> macOS, and WSL2.

Status: **v2.0.0-alpha** — API + web UI functionally complete (mirrors the
Terwo surface), installers and release hardening in progress. See
[`CHANGELOG.md`](CHANGELOG.md) and `.opencode/plan/` (PRD, specs, ADRs).

## Quickstart

One-line installs per OS (see [`installers/`](installers/) for details):

```bash
# Termux
curl -sL https://raw.githubusercontent.com/jhedev96/olp/main/installers/termux.sh | bash

# Debian / Ubuntu (as root)
curl -sL https://raw.githubusercontent.com/jhedev96/olp/main/installers/debian.sh | bash

# Arch / Alpine / Fedora / macOS — same pattern:
# installers/{arch,alpine,fedora,macos}.sh
```

Requires Node.js ≥ 22.12 (see [ADR-001](docs/adr-001-node-baseline.md)).
First run prints one-time credentials — change them in Settings.

Open: **http://127.0.0.1:8080** (or your LAN IP; installers bind `0.0.0.0`).

## Layout

```text
apps/server/     # Fastify API + WebSocket terminal + SPA hosting
apps/web/        # React + Vite + Tailwind SPA (10 slugs)
packages/auth | env-core | sysinfo | pkgman | services
cli/             # `olp` binary (install/start/stop/restart/status/logs)
installers/      # per-OS one-line scripts
docs/            # ADRs, migration guide
```

## Develop

```bash
npm install
npm run build   # all workspaces
npm run test    # Vitest per workspace (244 tests, zero real services)
```

Conventions live in [`.opencode/plan/PROJECT_RULES.md`](.opencode/plan/PROJECT_RULES.md):
one task = one commit (Conventional Commits, English), specs before code,
Terwo parity verified twice (see `SPECS/spec-*.md`).

## Security posture

- Binds `127.0.0.1` by default; installers opt into LAN (`0.0.0.0`) —
  trusted WiFi only, strong password required.
- Never expose the panel directly to the public internet; use an SSH
  tunnel or Cloudflare Tunnel for remote access.
- Migrating from Terwo? See [`docs/migrate-terwo.md`](docs/migrate-terwo.md).
