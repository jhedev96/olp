# ADR-004: Chart Library for the Redesign (Recharts)

- Status: Accepted
- Date: 2026-10-10
- Approved: 2026-10-10 (human)
- Scope: Which chart dependency the web UI uses, and the wrapper rules.

## Context

P2 needs charts for the dashboard/monitor redesign (CPU wave, memory
donut, disk bar, network spark). Finalists were Tremor and Recharts.
Registry evidence (2026-10-10) decided it before any install:

- Recharts `3.10.1`: peer deps admit React `^16 || ^17 || ^18 || ^19`
  (React 19 supported), MIT, actively maintained, `sideEffects: false`.
- `@tremor/react` `3.18.7`: peer dep is React `^18` only (no React 19
  support), and it is a wrapper layer — it depends on Recharts `^2`
  internally — plus Tailwind v3, `@tailwindcss/forms`, and headlessui.
  That stack conflicts with OLP's React 19 + Tailwind v4 and adds
  weight for zero chart-engine benefit. Last publish predates the
  current stack by a wide margin.

Installing the Tremor tree into a React 19 app to "spike" it would be
theater: the peer range already disqualifies it.

## Decision

1. **Use Recharts `^3` directly** (`apps/web` dependency, installed
   `3.10.1` clean with no peer warnings).
2. **Wrappers own the look**: `apps/web/src/components/charts/`
   (`CpuArea`, `MemoryDonut`, `DiskBar`, `NetSpark`) take ready data
   only — no fetching inside chart components, ever. Mockup palette
   (`#4edea3` brand, `#4cd7f6` secondary, `#2e3447` track, dark
   tooltip) lives in the wrappers, not in page code.
3. **No animation** (`isAnimationActive={false}` everywhere):
   deterministic jsdom renders (assertable SVG) and no rAF tax on
   low-end Termux devices.
4. **No `ResponsiveContainer`**: it needs layout measurement, which
   jsdom cannot do (untestable) and which costs a resize observer per
   chart on device. Wrappers take fixed `width`/`height` props with
   sane defaults; pages choose sizes per breakpoint.
5. **Every wrapper is labeled** (`aria-label` region + headline value
   as real text) so tests assert data→SVG/text mapping with static
   props, never library internals beyond stable class hooks.

## Consequences

- One chart dependency, no Tailwind/forms/headlessui fellow travelers.
- Charts render synchronously — safe for Vitest + jsdom and for P4
  screenshot audit.
- If Recharts v4 breaks the wrapper API, only the four wrappers change;
  page code is untouched (data-only props are the bulkhead).
