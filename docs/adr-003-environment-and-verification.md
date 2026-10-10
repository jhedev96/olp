# ADR-003: Build Environment and Verification Limits

- Status: Accepted
- Date: 2026-10-10
- Approved: 2026-10-10 (human)
- Scope: What CI/agent verification proves per target OS, and what it does not.

## Context

Agentic development for OLP happens in a proot Ubuntu box (headless, on
Android hardware, but NOT a Termux environment). This ADR records what that
environment can and cannot prove, so "parity" claims stay honest.

## Decision

1. **Agent-run builds, unit tests, and live-behavior smokes verify the
   Debian/Linux target only.** `env-core` correctly detects this box as
   `debian` (its `/etc/os-release` is Ubuntu). Results here say nothing
   about Termux, Alpine, macOS, or Windows behavior.
2. **Termux-specific paths are "code parity + injected tests" until proven
   on-device.** Covered: `termux-battery-status` handling, `pkg` catalog,
   pm2/Termux:Boot flow, `node-pty` on Android ARM. None of these have ever
   executed in this environment. Specs touching Termux must carry a
   "needs on-device verification" note.
3. **Termux verification is a manual gate owned by the human.** GitHub
   Actions has no Termux runner, and Playwright does not run on
   Android/Termux — so Termux is verified by running the dependency-light
   `smoke/` scripts on a real device before release, never by CI.
4. **E2E browser tooling is deferred to Phase 4 (Linux CI only).**
   Rationale: the frontend is still a skeleton and the API surface is still
   churning (brittle tests), Playwright cannot run on the P0 Termux target,
   and its ~120 MB browser payload contradicts the offline-first posture.
5. **Agentic E2E (tester-army/e2e and kin) is rejected.** An ops panel needs
   deterministic assertions (status codes, exact bytes, payload shapes), not
   semantic ones; model-driven tests add per-run cost, credentials, and
   nondeterminism. Revisit only if a deterministic layer proves insufficient.

## Consequences

- Do not claim "Termux parity verified" from agent-run evidence. Say
  "parity by code + injected tests, on-device verification pending".
- `smoke/` scripts must stay dependency-light (bash + curl + node only) so
  they run on stock Termux with no extra installs.
- The `node-pty` build failure observed in this sandbox (blocked install
  scripts) is a sandbox artifact, NOT evidence about Termux builds. Each
  platform's `node-pty` story is verified on that platform only.
- Battery `unavailable` on this headless box is a valid exercise of the
  degrade path, and counts as Linux verification of that branch.

## Follow-ups

- Add "needs on-device verification" markers to `spec-sysinfo.md`
  (Termux battery) and the future `pkgman`/installer specs.
- Define the `smoke/` script set and the manual Termux gate checklist in
  Phase 4 planning.
