# ADR-002: npm vs pnpm Workspaces

- Status: Proposed (needs human approval)
- Date: 2026-10-10
- Scope: OLP monorepo tooling (`package.json` workspaces vs `pnpm-workspace.yaml`)
- Depends on: ADR-001 (`>=22.12` baseline)

## Context

PLAN Phase 0 requires a locked workspace tool before scaffolding `apps/*` and `packages/*`. Candidates are npm workspaces (bundled with Node.js) and pnpm workspaces (performance-first alternative). The decision must honor Termux as P0: whatever we pick has to install and run on a phone with `pkg install nodejs`, no root, no hacks.

## Evidence

### pnpm strengths (upstream, 2026)

- Disk savings of 50-79% via content-addressable global store + hard links (single copy per package version shared across projects).
- Monorepo install speedups of 2-7x over npm in large workspace benchmarks (filtering, recursive commands, catalog protocol).
- Strict dependency isolation: prevents phantom-dependency bugs by default.
- pnpm 11+ requires Node.js 22+, which aligns cleanly with ADR-001 (`>=22.12`).
- Weekly downloads now exceed rivals combined (August 2026 reports); best-in-class monorepo filtering.

### pnpm on Termux (blocker)

- pnpm ships no prebuilt binary for Android (upstream issue `pnpm/pnpm#14679`, still open September 2026).
- Install via `npm i -g pnpm` succeeds, but runtime operations fail on Termux with `Permission denied (os error 13)` when linking store files into `node_modules` (reported on pnpm 12.x, store v11 layout).
- Root cause class: hard-link + store layout assumptions that do not hold on Android's filesystem/sandbox. No official workaround documented.
- Verdict: pnpm is not reliable on Termux today, and Termux is P0 parity. Making pnpm mandatory would break the primary install path.

### npm workspaces

- Bundled with every Node.js install; zero bootstrap step on Termux, Debian, Alpine, Fedora, macOS, WSL2.
- Workspace support since npm v7; npm v11 improved parallelization and stability, though still slower than pnpm on very large monorepos.
- No extra binary, no store permissions, no Android-specific breakage.
- Trade-off: higher disk usage and slower cold installs versus pnpm; weaker filtering primitives.

## Options

1. **npm workspaces as canonical, pnpm as opt-in (Recommended).** `package.json` `workspaces` field is the source of truth; CI and installers use npm only. Contributors on Linux/macOS may use pnpm locally if it works for them, but must verify with npm before pushing. No `pnpm-lock.yaml` committed initially.
2. **pnpm as canonical.** Rejected for v2.0: best performance and DX, but breaks Termux P0 with no upstream fix date.
3. **Support both lockfiles.** Rejected: doubles CI matrix and review burden for marginal gain at this stage. Revisit post-v2.0 if pnpm fixes Android support.

## Recommendation

Adopt Option 1. Scaffold with npm workspaces. Keep the layout pnpm-friendly (one `package.json` per workspace, no npm-specific hoisting tricks) so a future switch costs little. Document the Termux blocker in the README so contributors do not "fix" it by migrating lockfiles.

## Consequences

- All `package.json` files get `engines: { "node": ">=22.12", "npm": ">=10" }` (npm 10 ships with Node 22; npm 11 with Node 24 — both support workspaces).
- CI runs `npm ci` / `npm run build` / `npm run test` only. No pnpm setup step.
- Installers only ensure Node.js + npm; never require a separate pnpm bootstrap.
- Disk/speed cost accepted for v2.0; revisited when either (a) pnpm ships Android support, or (b) monorepo grows large enough that npm cold-install time becomes a gate problem.
- `docs/os-catalog-draft.md` (T00-04) must not list pnpm as a prerequisite on any OS.

## Follow-ups

- Re-check `pnpm/pnpm#14679` quarterly; if fixed and verified on-device, propose a follow-up ADR to adopt pnpm or dual lockfiles.
- If npm workspace performance becomes painful, evaluate `npm --prefer-offline` cache + CI store caching before reconsidering pnpm.

## Approval

- [ ] Human approves npm-canonical + pnpm-opt-in (then scaffold Phase 1 with npm workspaces).
