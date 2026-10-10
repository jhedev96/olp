# TASKS — Phase 10 frontend redesign (mockup conversion)

> Each task = one local commit (rules §2). Order matters: shell before
> pages, shared before consumers, spike before chart wrappers.
> Backend stays frozen (rules §10.6) — dummies link CANDIDATES.md ids.

## P0 — Inventory detail (reads `code.html` properly, fills INVENTORY_WEB.md)

- [ ] P0a: shell + brand + logo (sidebar/header/nav/labels/icon map/brand strings)
- [ ] P0b: dashboard + monitor screens (cards, services section, all monitor panels)
- [ ] P0c: files + terminal screens (editor, preview, keymap, banners)
- [ ] P0d: websites + database screens (deploy modal, proxy section, create-db)
- [ ] P0e: store + cron + backup + settings + login screens (forms, extras)
- [ ] P0f: empty CAND-007/CAND-008 (every TBD resolved to real/dummy/candidate)

## P1 — AppShell

- [ ] Brand asset self-host + Sidebar + Header + `/monitor` nav + outlet wiring
- [ ] Rebrand sweep (no Terwo strings in `apps/web/src`, tests updated)

## P2 — Shared

- [ ] Dialog primitive (confirm + prompt replacements)
- [ ] Chart spike (Tremor vs Recharts, fake data) → chart ADR → wrappers
- [ ] DataTable + Badge + ComingSoon + EmptyState
- [ ] Migrate all `confirm()`/`prompt()` call sites to Dialog

## P3 — Pages (one series each: markup → wire → tests)

- [ ] login, dashboard, monitor (mostly dummies + CANDIDATE badges)
- [ ] files, terminal, websites (+nginx section)
- [ ] database, store, cron, backup, settings

## P4 — Visual audit (per screen vs `screen.png`, desktop + mobile width)

## P5 — Cleanup (dead skeleton code, emoji icons, unused placeholders)
