# CANDIDATES — next-wave feature backlog (frontend redesign dummies)

> Every `dummy` / `new-backend` item from the web redesign MUST have an
> entry here (rules §10.5). A dummy without a candidate id is an
> incomplete task. Full specs are written when a candidate is scheduled —
> these are stubs, not specs.

| ID | Feature (mockup screen) | Backend needed | Notes |
|---|---|---|---|
| CAND-001 | ~~Monitor: process list + PM2 rows~~ | Shipped wave 1: `GET /api/monitor/processes` + page table (CLOSED 2026-10-12) | PM2 rows best-effort (hidden when absent) |
| CAND-002 | ~~Monitor: network RX/TX + sockets~~ | Shipped wave 1: `summary.net` + page spark/lists (CLOSED 2026-10-12) | Rates via sampler deltas; ring buffer client-side |
| CAND-003 | ~~Monitor: per-core GHz + frequency wave~~ | Shipped wave 1: `summary.cpu.perCore[]` + page bars (CLOSED 2026-10-12) | 3-cluster grouping stays a frontend heuristic |
| CAND-004 | ~~Monitor: kill runaway process~~ | Shipped wave 2: per-row Kill + `POST .../:pid/kill` under deny-by-default authz (CLOSED 2026-10-12) | Security-read the diff; TOCTOU accepted residual, TERM-first + dialog names pid+command |
| CAND-005 | Dashboard: Services & Daemons section | NEW: daemon status+control endpoint (mariadb/pg/redis/cronie) or reuse `services` package server-side | Refined P0b: cards show ACTIVE/START per daemon; pairs with `pkgman`/`services` backend wave |
| CAND-006 | Database: Create New Database button | NEW: `POST /api/db/:engine/databases` (CREATE DATABASE) | Small; needs privilege + validation design |
| CAND-007 | ~~Backup extras beyond CRUD~~ | SUPERSEDED by P0e row detail + CAND-029 (closed 2026-10-10) | Catch-all emptied, do not reopen |
| CAND-008 | ~~Unresolved P0 leftovers~~ | SUPERSEDED — P0 closed 2026-10-10 with zero TBD rows | Catch-all emptied, do not reopen |
| CAND-009 | Lucide icon pass (replace emoji) | none (frontend-only) | Opportunistic per page; files page partially done |
| CAND-010 | ~~`confirm()`/`prompt()` → Dialog~~ | none (frontend-only) | CLOSED 2026-10-10: shared `Dialog` + all 10 call sites migrated (6 pages) |
| CAND-011 | Header avatar / user profiles | NEW or dummy-forever (single-admin has no profiles) | From P0a shell read; likely permanent dummy |
| CAND-012 | Self-hosted Geist + JetBrains Mono | none (asset weight decision) | System stack ships v1; revisit with size budget |
| CAND-013 | Dashboard: live panel log tail (+copy/clear) | NEW: panel log tail endpoint (pm2/journald backends) | From P0b; pairs with watchdog-adjacent work, separate spec |
| CAND-014 | ~~Extended system telemetry (temp, freq, zram, net I/O, sockets, per-core, disk rates, model/kernel/arch)~~ | Shipped wave 1: `GET /api/monitor/summary` (CLOSED 2026-10-12) | Wakelock line dropped with record (no queryable source); FS label out (no portable source) |
| CAND-015 | Per-site memory + engine version; panel self-restart | NEW: site process stats + restart endpoint (authz design) | From P0b dashboard read; self-restart needs privilege design |
| CAND-016 | File mode/owner in listings + chmod editing | NEW: stat mode in file entries + chmod endpoint | From P0c files read (Chmod column, 0755/0644 strings, ACL card) |
| CAND-017 | Terminal workspaces (multi-tab sessions, split panes, per-tab TTY) | NEW: multi-session manager + tab metadata (TTY, proc names) | From P0c terminal read; singleton manager today |
| CAND-018 | WS latency indicator | EXTEND: ping/pong in WS protocol | From P0c terminal read (0.4ms badge); tiny protocol addition |
| CAND-019 | Storage mounts/shortcuts card | NEW: root-path + Termux storage probe endpoint (or static per-env map) | From P0c files read; fold Termux symlink health here |
| CAND-020 | Per-site auto-restart toggle | NEW: autorestart flag on sites + supervisor respawn | From P0d websites read (toggle per app card) |
| CAND-021 | Nginx vhost advanced (SSL states, per-vhost toggles, conf edit, master stats) | NEW: nginx conf parse/manage endpoints | From P0d proxy read; CRUD stays real, this is the advanced layer |
| CAND-022 | Port availability indicator in deploy modal | NEW: tiny port-probe endpoint (or attempt-bind) | From P0d add-modal read |
| CAND-023 | Custom startup command per site | NEW: command field + runner (breaks fixed per-type runners) | From P0d add-modal read; design carefully (jail implications) |
| CAND-024 | Redis engine + browser | NEW: full Redis driver (INFO/KEYS/GET) + UI engine tab | From P0d database read (engine card exists in mockup) |
| CAND-025 | SQL import/export file transfer | NEW: dump/restore-via-upload endpoints (or backup-module reuse) | From P0d database read (Import/Export buttons) |
| CAND-026 | Schema DDL view + table sizes/row counts + data-vs-index panel | NEW: information_schema endpoints (or composed ad-hoc SQL — decide in wave) | From P0d database read |
| CAND-027 | Store extras (pkg update, batch upgrade, installed versions, conf path + Configure, mirror/latency) | NEW: package-management endpoints (update/upgrade/version probe) | From P0e store read; versions need per-bin `--version` mapping |
| CAND-028 | Cron extras (dry-run-all, next-run countdown, dispatch stats/latency, battery card, daemon PID) | NEW: execution-history tracking + schedule math + daemon introspection | From P0e cron read; stats need run-result persistence |
| CAND-029 | Backup advanced (scheduled snapshots, upload import, SHA256 verify, full-system bundle, gzip variant) | NEW: scheduler integration + upload/restore + hash endpoints | From P0e backup read |
| CAND-030 | Active device sessions table + per-session revoke | NEW: session metadata tracking (UA/IP/last-seen) + revoke endpoint | From P0e settings read; privacy design (what to store) required |
| CAND-031 | Server config management (bind controls, telegram verified badge, remember-me 30d, rehash flag) + PBKDF2 display decision | MIXED: verified-badge needs getMe proxy (small NEW); bind controls need restart-capable config (design); remember-me needs TTL option; rehash flag + 310k text need HUMAN DROP DECISION (no cryptographic effect, contradicts 120k truth) | From P0e settings+login read; user decision pending on the drop |
| CAND-032 | Alternative auth methods (hardware passkey, biometric, local pipe) | NEW: full auth-method wave (WebAuthn ceremony or pipe handshake + UI) | From P3 login build; buttons ship disabled with this id |
| CAND-033 | Editor prettify + diff view | NEW: formatter dependency (prettier/--check?) + diff rendering vs opened snapshot | From P4 files audit; Discard already real (snapshot kept per tab) |
| CAND-034 | Terminal snippet/macro runners (desktop macros row + mobile one-touch runners) | NEW: stored snippet list + one-tap send (all client-side; needs UX + storage design) | From P4 terminal audit (both desktop and mobile mockups) |

Rules: add rows only from inventory verdicts (no drive-by ideas without
a mockup source); when scheduling, write the full spec first (rules §1).
