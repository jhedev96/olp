# TASKS — Phase 00 Discovery & Research

> Each task = one local commit. No task touches more than ~5 files.
> Template per task: Acceptance + Verify + Files.

## T00-01: Inventory legacy routes and limits

- [ ] Task: Record all HTTP/WS routes, helpers, and magic constants from `terwo/panel.js` into a table.
  - Acceptance: Table lists every endpoint (`/api/files`, `/api/sites/*`, `/api/db/*`, `/api/nginx/*`, `/api/cron/*`, WS terminal), plus caps (50 MB upload, 1 MB edit, 300-line site logs, 500-line install logs, 24h session, 20k SQL chars).
  - Verify: `grep -n "api\|sendJson\|servePublic" ../../terwo/panel.js` reviewed; table committed in `docs/inventory.md` (future) or as appendix to relevant specs.
  - Files: new inventory note only (no code change).

## T00-02: ADR-001 Node.js baseline

- [ ] Task: Research distro-packaged Node versions (Debian stable, Ubuntu LTS, Arch, Alpine, Fedora, Termux `pkg`, macOS brew) + `node-pty` + Fastify compat; propose minimum (candidate: 20 LTS).
  - Acceptance: `docs/adr-001-node-baseline.md` with Decision, Alternatives (18/20/22), Consequences.
  - Verify: version table cites sources; decision approved by human.
  - Files: `docs/adr-001-node-baseline.md` only.

## T00-03: ADR-002 Package manager (npm vs pnpm)

- [ ] Task: Compare npm workspaces vs pnpm workspaces for the OLP monorepo (install speed, disk, CI cache, Termux support).
  - Acceptance: ADR with decision and migration cost noted.
  - Verify: trial `install` on Termux + Debian documented (or explicitly deferred with reason).
  - Files: `docs/adr-002-package-manager.md` only.

## T00-04: Per-OS package catalog research

- [ ] Task: Build draft catalog table for Store items across apt/pacman/apk/dnf/brew/pkg (package name, service name, notes on drift e.g. mariadb vs mysql).
  - Acceptance: Markdown table covers all 26 current Store items with per-OS names or `TBD-research`.
  - Verify: at least P0 (pkg/apt) fully filled; P1 marked with source links.
  - Files: `docs/os-catalog-draft.md` only.

## T00-05: Auth upgrade decision input

- [ ] Task: Compare PBKDF2-120k (current) vs argon2id for v2.0 (deps, Termux build feasibility, migration path for existing `config.json` hashes).
  - Acceptance: Decision input recorded in `SPECS/spec-auth.md` Open Questions section.
  - Verify: no code change; human approves stay-vs-migrate before Phase 3 auth port.
  - Files: spec appendix only.
