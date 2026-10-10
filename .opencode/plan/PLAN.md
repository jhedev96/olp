# PLAN — Terwo -> OpenLocalPanel (OLP) Evolution

> Status: DRAFT skeleton v0.1. Companion to `PRD.md`. Governed by `PROJECT_RULES.md`.
> Stack locked: TypeScript + Fastify (server), Vite (web). Windows native deferred. systemd + openrc both in scope.

## 0. Principles

- Strangler pattern: legacy `terwo/panel.js` keeps running while modules are extracted one by one. No big-bang rewrite.
- One plan -> many tasks -> one spec per module. One task = one local commit.
- Interface-first: `env-core` is built before any OS-specific logic is ported.
- Every phase ends with a verifiable gate. No phase starts with a red gate.

## 1. Target Repository Layout

```text
olp/                          # new monorepo root (sibling of terwo/ during migration)
  package.json                # npm workspaces
  tsconfig.base.json
  apps/
    server/                   # Fastify + @fastify/websocket, auth, REST /api/*
      src/
        routes/               # one file per domain (auth, files, terminal, sites, proxy, db, store, cron, backup, settings, telegram, stats)
        lib/                  # safePath, safeName, body limits, mime, shell exec
      test/
    web/                      # Vite + Tailwind + local lucide/xterm (npm), SPA with Terwo slugs
      src/pages/              # login, dashboard, website, database, files, cron, backup, settings, terminal, store
      src/components/
  packages/
    env-core/                 # detect(): termux|debian|arch|alpine|fedora|rhel|macos|wsl2|windows; Environment interface
    pkgman/                   # per-OS catalog: { id, name, desc, check, installCommands: Record<Env, string> }
    services/                 # adapters: pm2 | systemd | openrc | launchd | windows-sc (stub)
    sysinfo/                  # cpu/mem/disk/uptime/battery providers per OS
    auth/                     # hash, session, config load/save + migration ~/.termux-panel -> ~/.olp
    sites/                    # node/php/static/go runners (PORT injection, log ring)
    telegram/                 # send + poll, allowlisted chat
  cli/                        # `olp` entry: install/start/status/logs
  installers/                 # termux.sh, debian.sh, arch.sh, alpine.sh, fedora.sh, macos.sh, wsl2.sh
  docs/                       # README per OS + migration guide
```

Tooling: `pnpm` or `npm` workspaces (decide in Phase 1), ESLint + Prettier, Vitest, `tsx` for dev, `tsc` build.

## 2. Phases

### Phase 0 — Discovery & Research (gating for all else)

- Tasks: inventory `panel.js` routes/helpers (auth, files x9, sites x6, store x3, db x9, settings/telegram x5, stats/battery, nginx x6, cron); record limits (50 MB upload, 1 MB edit, 300-line site logs, 500-line install logs, 24h session).
- Tasks: Node baseline research (distro-packaged versions, node-pty matrix, Fastify/Node compat) -> ADR deciding minimum (candidate: Node 20 LTS).
- Tasks: per-OS catalog research (package names for nginx, php, python, go, mariadb, postgres, redis, cron; `winget` deferred but interface reserved).
- Gate: ADR `docs/adr-001-node-baseline.md` approved; route inventory checked in.

### Phase 1 — Foundation (rebrand + monorepo skeleton)

- Tasks: scaffold workspaces, TS strict, Fastify hello + healthz, Vite hello preserving `/login /dashboard /...` slugs, shared ESLint/Prettier, Vitest, CI workflow (build+lint+test).
- Tasks: rebrand constants (`OLP`, `~/.olp`, `PANEL_*` env kept for compat), license/README skeleton, legacy `terwo/` frozen as read-only reference.
- Gate: `npm run build && npm run lint && npm run test` green; both apps boot locally.

### Phase 2 — env-core + Cross-Cutting Libs (must precede all ports)

- Tasks (per `SPECS/spec-env-core.md`): `detect()` via `/etc/os-release` + `PREFIX`/`WSL_DISTRO_NAME`/`process.platform`; `Environment { id, pkgman, service, shell, paths }`; unit tests with fixture `os-release` files.
- Tasks: port `safePath`, `safeName`, `readBody` limits, `sendJson` semantics, `EXEC_ENV`/`SHELL` resolution, `sq()` quoting into `apps/server/src/lib` with tests.
- Tasks: `auth` package (PBKDF2 compat + config migration) with tests.
- Gate: `env-core` unit suite covers all 8 detection keys; lib tests cover traversal + limit cases.

### Phase 3 — Strangler Port (one domain per task series, order matters)

Order: `stats/sysinfo` -> `auth/settings` -> `files` -> `terminal WS` -> `sites` -> `proxy` -> `database` -> `store (pkgman-backed)` -> `cron` -> `backup` -> `telegram`.

- Each domain: write `SPECS/spec-<domain>.md` first, then route + tests, then parity check against legacy behavior (status codes, caps, error messages in English).
- Terminal is highest risk (node-pty vs pipe fallback) — isolate behind interface early.
- Gate per domain: parity checklist signed + legacy route disabled behind flag.

### Phase 4 — Multi-OS Hardening

- Tasks: `pkgman` catalog per OS + dry-run tests; `services` adapters (systemd unit, openrc init script, launchd plist, pm2/Termux:Boot retained).
- Tasks: `sysinfo` providers (battery: Termux:API / UPower / IOKit / WMI-stub; disk via `df` abstraction; cores via `os.cpus()` + `/proc` fallback).
- Tasks: installer scripts + smoke test per OS (P0 Termux/Debian first, then P1 Arch/Alpine/Fedora).
- Gate: smoke suite passes on P0+P1 matrix.

### Phase 5 — Release v2.0

- Tasks: migration tool (`olp migrate --from ~/.termux-panel`), docs per OS, changelog, version `2.0.0`, tag, GitHub release.
- Tasks: freeze legacy `terwo/` with pointer README; archive install path.
- Gate: PRD success metrics met; release checklist complete.

Follow-up plan (out of scope here): Windows-native full support.

## 3. Task & Commit Discipline

- Tasks live in `TASKS/` (one file per phase, e.g. `TASKS/phase-02-env-core.md`), each task maps to exactly one local commit (`feat|fix|chore|docs|refactor|test(scope): subject`, English, imperative).
- No task touches more than ~5 files. Larger work is split before starting.
- Each task lists Acceptance + Verify (`npm run build`, `vitest run <scope>`, manual curl/WS check).

## 4. Verification Strategy

- Unit: Vitest per package (env detection fixtures, path jail, catalog rendering).
- Contract: Fastify route tests via `inject()` preserving legacy status/error shapes.
- Smoke (per OS): script exercising login -> files list -> sysinfo -> site start/stop -> store dry-run.
- Gates run in CI on every commit; OS matrix runs on PR to main.

## 5. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| node-pty fails on Alpine/Windows | Ship pipe-mode fallback; mark degraded in UI; test both paths |
| Service install needs sudo | Fail closed with copy-pasteable command; never sudo silently |
| Catalog drift | Catalog is data + CI lint; PR per distro bump |
| Rewrite stall | Strangler + domain order keeps Termux usable at every commit |

## 6. Milestones (proposed, to be dated after Phase 0)

- M1: Foundation boots (Phase 1 gate).
- M2: env-core + auth + stats parity on Termux + Debian.
- M3: Full domain parity on Termux.
- M4: P0+P1 OS matrix green.
- M5: v2.0.0 release.

## 7. Open Research (feeds ADRs, does not block Phase 1 skeleton)

- Node minimum version — locked per ADR-001: `>=22.12` (Node 24 preferred for fresh installs).
- npm vs pnpm workspaces.
- argon2id upgrade timing.
- Caddy evaluation (post-v2.0).
