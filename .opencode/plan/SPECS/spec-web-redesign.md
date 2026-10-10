# SPEC — web redesign (mockup conversion)

> Amends `spec-web.md` (stack: React + Vite + Tailwind v4 + shadcn-style
> primitives, mini slug router — all locked, unchanged here).
> Owner: TBD. Status: DRAFT.
> Depends on: mockups under `mockup/stitch_terwo_ui_redesign/` (27 screens:
> desktop + mobile pairs, modals, logo), locked decisions (OLP rebrand now,
> new `/monitor` slug, dummy-first, Lucide mapping, logo self-host).
> Gate: approve before P1 (AppShell) starts. P0 inventory fills
> `INVENTORY_WEB.md`; this spec defines the target shape + policies.

## 1. Objective

Convert every mockup screen to React components with full mockup parity —
same shell, same pages, same features — splitting shared pieces (sidebar,
header, dialog, table, charts) and wiring real backends where they exist.
Features without backends ship as disabled Coming-Soon dummies tracked in
`CANDIDATES.md` (never silently dropped, never scope-crept into the wave).

Success: side-by-side per screen, mockup vs app is indistinguishable in
layout and copy (modulo OLP rebrand strings); every mockup feature is
`real` or a tracked dummy; `npm run build + test` green throughout.

## 2. API Contract (TypeScript)

```ts
// apps/web/src/components/shell/AppShell.tsx
export function AppShell({ slug, children }: { slug: Slug; children: React.ReactNode }): React.ReactElement;
// - Sidebar: brand block (self-hosted logo, name, version, env badge, host),
//   nav (dashboard, files, terminal, website, database, store, cron, backup,
//   settings, monitor), theme toggle, logout. Active slug highlighted.
// - Header: current page title, host badge, (avatar/menu per mockup P0 verdict).
// - <Outlet> region renders the page.

// apps/web/src/components/common/ComingSoon.tsx
export function ComingSoon({ feature, candidate }: { feature: string; candidate: string }): React.ReactElement;
// - Disabled placeholder with badge linking to the CANDIDATES.md id.

// apps/web/src/components/charts/*.tsx (behind the chart ADR verdict)
// - CpuArea, MemoryDonut, DiskBar, NetSpark (props take ready data only —
//   no fetching inside chart components, ever).
```

### Behavior

- Slugs: existing 10 plus new `monitor` (`/monitor`, P1 nav item).
  Unknown paths still fall back to dashboard.
- Rebrand: every user-visible "Terwo"/version string becomes
  OpenLocalPanel/`2.0.0-alpha.1+` (exact strings locked in P0 inventory;
  no legacy brand text ships).
- Theme: dark default + light variant per mockup `*_light_mode` screens;
  the existing `olp-theme` key + `light` class mechanism stays.
- Dialog (approved): shadcn-style modal replaces ALL `window.confirm`
  and `window.prompt` call sites (files rename/delete, sites delete,
  cron delete, backup restore/delete, settings logout-all, terminal new
  session). Destructive actions keep the two-step (open → confirm).
- Tables/badges/forms keep current API payloads; only markup changes to
  mockup shape (no endpoint changes in this wave — backend frozen).
- Charts render from `/api/stats` (+ extended fields only if a later
  wave adds them — P0 marks each chart real-or-dummy with the reason).
- Mobile mockups resolve to responsive breakpoints (single codebase;
  no separate mobile pages). Breakpoint behavior recorded per component
  in the inventory (sidebar drawer vs rail, header collapse, table
  scroll).
- Dummy sections render real layout with disabled controls + ComingSoon
  badge (never empty holes, never fake live data).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/web
Test:  npm run test --workspace=@olp/web
```

## 4. Project Structure

```text
apps/web/src/
  lib/                # unchanged (api/format/router/theme + utils)
  components/shell/   # AppShell, Sidebar, Header, NavItem, BrandBlock
  components/common/  # Dialog, DataTable, Badge, ComingSoon, EmptyState
  components/charts/  # per ADR verdict (wrappers over the chosen lib)
  components/ui/      # existing shadcn-style primitives (extended as needed)
  pages/              # one module per slug + monitor.tsx (new)
  assets/logo.*       # self-hosted brand (from mockup terwo_logo, rebranded)
mockup/               # read-only source (never edited, never imported)
```

## 5. Code Style

- Function components + hooks; data fetching in pages (never in chart/
  presentational components); cleanup in effects (pollers, sockets).
- No `any`; no direct `fetch` outside `lib/api.ts`; no
  `dangerouslySetInnerHTML`; English comments/JSDoc.
- Icon rule: Lucide imports only (`import { X } from 'lucide'`), mapped
  per INVENTORY_WEB.md Material→Lucide table; no emoji icons in new code
  (existing emoji replaced opportunistically per page).

## 6. Testing Strategy

- Framework: Vitest + jsdom + `@testing-library/react` (unchanged).
- Per task: render against mocked `fetch` (existing stub pattern);
  assert layout markers (nav active state, headings, badges), payloads
  sent, dialog open/confirm/cancel flows, ComingSoon presence for
  dummies (assert the candidate id renders — keeps backlog honest).
- Chart components: assert data→SVG/text mapping with static props
  (no library internals); lib choice covered by the spike, not unit tests.
- P4 audit is manual per-screen vs `screen.png` (checklist in inventory).

## 7. Boundaries

- Always: mockup wins on layout/copy; rebrand strings; disabled (never
  fake-live) dummies with candidate ids.
- Ask first: any deviation from a mockup screen; dropping a feature
  (requires explicit human per-item approval); new slugs beyond monitor.
- Never: edit `mockup/`; hotlink brand assets; add backend endpoints in
  this wave; invent live data for dummy charts.

## 8. Success Criteria

- [ ] AppShell + all 11 slugs render with mockup layout; rebrand clean
  (`grep -ri terwo apps/web/src` empty, modulo code comments referencing
  parity sources).
- [ ] Dialog replaces every `confirm()`/`prompt()` call site
  (`grep -rn "window.confirm\|window.prompt" apps/web/src` empty).
- [ ] Every inventory row is `real` or a badged dummy with candidate id.
- [ ] P4 per-screen audit signed off; `npm run build + test` green.

## 9. Open Questions

- Chart library — decided by spike ADR (Tremor vs Recharts finalists),
  not here.
- Exact OLP brand strings (name/version/env badge text) — locked in P0
  inventory against the brand block mockup.

## 10. Decisions

- Single responsive codebase (no mobile page forks).
- Backend frozen for the redesign wave (dummy-first, locked with human).
- `mockup/` is read-only source (never imported, never edited).

## 11. Parity mapping (§9.2, UI→mockup)

- Full per-screen table lives in `INVENTORY_WEB.md` (P0 output). This
  spec carries the policies; the matrix carries the evidence.
