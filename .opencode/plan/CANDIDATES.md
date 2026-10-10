# CANDIDATES — next-wave feature backlog (frontend redesign dummies)

> Every `dummy` / `new-backend` item from the web redesign MUST have an
> entry here (rules §10.5). A dummy without a candidate id is an
> incomplete task. Full specs are written when a candidate is scheduled —
> these are stubs, not specs.

| ID | Feature (mockup screen) | Backend needed | Notes |
|---|---|---|---|
| CAND-001 | Monitor: process list + PM2 rows | NEW: process enumeration endpoint (`/api/monitor/processes`?) | Biggest dummy; design the endpoint in its wave |
| CAND-002 | Monitor: network RX/TX + sockets | NEW: network I/O endpoint | Needs per-OS collection research (Linux `/proc/net`, others?) |
| CAND-003 | Monitor: per-core GHz + frequency wave | EXTEND: per-core stats in sysinfo (currently load avg + count only) | Small extension, pairs with CAND-001 wave |
| CAND-004 | Monitor: kill runaway process | NEW: privileged kill endpoint (authz design required — dangerous) | Security review mandatory before building |
| CAND-005 | Dashboard: Services & Daemons section | NEW: daemon status+control endpoint (mariadb/pg/redis/cronie) or reuse `services` package server-side | Refined P0b: cards show ACTIVE/START per daemon; pairs with `pkgman`/`services` backend wave |
| CAND-006 | Database: Create New Database button | NEW: `POST /api/db/:engine/databases` (CREATE DATABASE) | Small; needs privilege + validation design |
| CAND-007 | Backup: extras beyond CRUD | TBD in P0 inventory (backup screen is 58 KB — audit it) | Fill after P0 reads the screen properly |
| CAND-008 | Settings/others: extras found in P0 | TBD in P0 inventory | Catch-all, must be emptied or itemized by P0 end |
| CAND-009 | Lucide icon pass (replace emoji) | none (frontend-only) | Opportunistic per page; files page partially done |
| CAND-010 | `confirm()`/`prompt()` → Dialog | none (frontend-only, approved) | P2 shared Dialog unblocks all call sites |
| CAND-011 | Header avatar / user profiles | NEW or dummy-forever (single-admin has no profiles) | From P0a shell read; likely permanent dummy |
| CAND-012 | Self-hosted Geist + JetBrains Mono | none (asset weight decision) | System stack ships v1; revisit with size budget |
| CAND-013 | Dashboard: live panel log tail (+copy/clear) | NEW: panel log tail endpoint (pm2/journald backends) | From P0b; pairs with watchdog-adjacent work, separate spec |
| CAND-014 | Extended system telemetry (temp, freq, zram, net I/O, sockets, per-core, disk rates, model/kernel/arch) | NEW: telemetry endpoint(s), per-OS collection research | From P0b monitor read; biggest research item after processes |
| CAND-015 | Per-site memory + engine version; panel self-restart | NEW: site process stats + restart endpoint (authz design) | From P0b dashboard read; self-restart needs privilege design |

Rules: add rows only from inventory verdicts (no drive-by ideas without
a mockup source); when scheduling, write the full spec first (rules §1).
