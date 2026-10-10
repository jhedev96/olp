# ADR-001: Node.js Minimum Version

- Status: Proposed (needs human approval)
- Date: 2026-10-10
- Scope: OLP monorepo (`apps/server`, `apps/web`, `packages/*`, `cli/`)
- Supersedes: PLAN.md placeholder "candidate Node 20 LTS"

## Context

PLAN Phase 0 requires a locked Node.js baseline before scaffolding. The initial candidate (Node 20 LTS) is no longer viable: Node 20 reached End-of-Life on 2026-04-30, and OLP stack choices (Fastify v5, Vite 7/8) have stricter floors.

Legacy Terwo runs on whatever Termux ships (unpinned `pkg install nodejs`), with no `engines` field. OLP must pin a baseline for CI, installers, and `node-pty` expectations.

## Evidence

### Upstream schedule (October 2026)

| Line | Status | EOL | Note |
|---|---|---|---|
| Node 24 (Krypton) | Active LTS | 2028-04-30 | Preferred for fresh installs |
| Node 22 (Jod) | Maintenance LTS | 2027-04-30 | Viable minimum |
| Node 20 (Iron) | EOL | 2026-04-30 | No security patches; must not be the baseline |
| Node 18 and below | EOL | past | Out of scope |

Sources: nodejs.org release schedule, endoflife.date/nodejs (checked 2026-10-10).

### Framework floors

- Fastify v5 requires Node.js 20+ (Fastify docs, Migration Guide v5). Node 20 EOL makes 22 the de facto floor for new Fastify v5 deployments.
- Vite 7/8 requires Node.js 20.19+ or 22.12+ (vite.dev announcements). The `22.12+` qualifier matters: not all Node 22 builds qualify.

### Distro-packaged versions (why `apt install nodejs` is not enough)

| Environment | Default `nodejs` | Verdict |
|---|---|---|
| Debian 13 (trixie) | 20.19.2 | EOL upstream; do not rely on default |
| Debian 12 (bookworm) | 18.x | EOL; do not rely on default |
| Ubuntu 24.04 (noble) | 18.19.1 | EOL; do not rely on default |
| Ubuntu 22.04 (jammy) | 12.22.x | EOL; do not rely on default |
| Arch (extra, rolling) | current (26.x per repology snapshot) | OK, rolling |
| Alpine (main) | LTS-tracked | OK, verify musl `node-pty` fallback |
| Fedora | `nodejs` + versioned `nodejs24` package | OK via versioned package |
| Termux (`pkg install nodejs`) | defaults to v22 track (community reports); `nodejs-lts` also available | OK, verify on device |
| macOS (brew) | current LTS | OK |

Conclusion: Debian/Ubuntu installers must use NodeSource (or equivalent upstream) rather than distro defaults. Other environments can use native tracks after verification.

## Options

1. **Node >= 22.12 (Recommended).** Aligns with Vite `22.12+` floor, Fastify v5, and Maintenance LTS runway to 2027-04-30. CI tests 22 + 24.
2. **Node >= 24.** Longest runway (to 2028) but excludes Termux/older VPS images still on the 22 track. Revisit once 22 approaches EOL.
3. **Node >= 20.19.** Rejected: satisfies Vite/Fastify floors on paper but tracks an EOL runtime with no security patches.

## Recommendation

Adopt Option 1: `engines: { "node": ">=22.12" }` across all workspaces. Document Node 24 as the preferred install for new setups. Revisit minimum when Node 22 enters EOL window (early 2027) with a planned bump to 24.

## Consequences

- CI matrix: Node 22.x + 24.x on P0/P1 environments. Node 20 explicitly excluded (fail-fast with message).
- Installers: Debian/Ubuntu scripts must add NodeSource `node_22.x` (or `node_24.x` for fresh installs) instead of plain `apt install nodejs`. Termux/Arch/Alpine/Fedora/macOS use native tracks with version check `node -v`.
- `node-pty`: still needs per-OS build verification (especially Alpine musl and Termux); pipe-mode fallback stays mandatory regardless of Node version.
- Docs: README quickstart per OS must state the Node requirement and the NodeSource step for Debian/Ubuntu.

## Follow-ups (not blocking)

- Verify `pkg install nodejs` version on a real Termux device and record exact `node -v`.
- Verify Alpine musl `node-pty` build on Node 22/24.
- File ADR-002 (npm vs pnpm) must respect this baseline.

## Approval

- [ ] Human approves `>=22.12` baseline (then update PLAN.md, PRD success criteria, and all `package.json` engines).
