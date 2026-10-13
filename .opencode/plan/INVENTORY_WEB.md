# INVENTORY_WEB — mockup → components → features matrix

> Source: `mockup/stitch_terwo_ui_redesign/` (27 screens: desktop + mobile
> pairs, modals, logo). Shell rows verified by grep 2026-10-10; per-screen
> detail fills in during P0 (each row needs a `code.html` read, not a grep).
> Verdicts: `real` (backend ready) | `dummy` (+CANDIDATE id) |
> `new-backend` (+CANDIDATE id, built as dummy now).

## Shell (P0a resolved 2026-10-10 from `terwo_dashboard_revisi/code.html`)

Sidebar (fixed `w-64`, dark surface):
| Element | Mockup exact | OLP target |
|---|---|---|
| Brand row | logo img + `Terwo` + badge `v2.4` | `BrandBlock`: self-hosted SVG (glyph kept, wordmark → `olp`, badge → package version), no hotlink |
| Env pill | pulsing dot + `Termux Online` + mono `:8080` | dynamic: env label from `env-core` + port from config (real) |
| Nav (order!) | dashboard, website, database, files, terminal, store, cron, backup, settings (+ **monitor** appended — locked decision, absent in mockup) | `Sidebar` with `data-path` parity + active highlight |
| Nav icons (Material→Lucide) | grid_view, language, database, folder, terminal, storefront, schedule, cloud_sync, tune, [monitor→activity] | layout-dashboard, globe, database, folder, terminal, store, calendar-clock, archive, settings, activity |
| Bottom row | theme toggle (dark_mode), Quick Terminal (code → terminal), Logout (→ login) | real (theme/logout exist; quick-terminal navigates) |
| Mobile | bottom tab bar (`fixed bottom-0`, safe-area): dashboard, database, files, websites + overflow TBD | responsive: bottom bar ≤md, rail hidden; overflow pattern verified in P1 |

Header (fixed, backdrop-blur):
| Element | Mockup exact | OLP target |
|---|---|---|
| HOST pill | dns icon + `HOST:` + hostname (`termux-node`) | real (`/api/stats` hostname) |
| IP pill (sm+) | router icon + `IP:` + `addr:port` | real (location.host — no new endpoint needed) |
| Quick Terminal button | → terminal | real (navigate) |
| Active Session pill | green dot + text | real (session valid = active) |
| Avatar circle | person icon (decorative) | dummy (no user profiles — CAND-011) |

Theme system:
| Mockup | OLP target |
|---|---|
| Tailwind `darkMode: class`, custom palette (`background #0c1324`, `primary #4edea3`), Geist + JetBrains Mono via Google Fonts | Tailwind v4 `@theme` tokens (palette parity); fonts: system stack v1 (offline-first — Geist self-host is CAND-012, needs weight/size decision) |

## Screens (detail: P0 — one subtask per row group)

| Screen (folder) | Components | Features → verdict |
|---|---|---|
| `terwo_login_auth_gateway` (+mobile) | LoginPage restyle + marketing panel + auth methods | Form real; marketing values real via `/api/stats` (swap line → CAND-014); air-gapped notice + feature badges static real; first-boot help + copy button real; remember-me checkbox real (wave-9, CAND-031 closed); passkey + local pipe auth real (wave-12 live shapes, CAND-032 closed; full ceremony human-gated); clear buttons real |
| `terwo_dashboard_revisi` (+mobile, +light) | Dashboard restyle, ServicesDaemons, StorePreview, LiveLog | Cards: real (loadavg/cores/mem/disk/battery/uptime); extras stay out: CPU temp, per-core freq, ZRAM/swap, disk FS type, battery temp/wakelock/power, PM2 badge, per-site memory+engine version (CAND-014/015); open-site links real; header buttons: restart-panel → CAND-015, web-terminal/new-website real (navigate); LiveLog panel → CAND-013; Services section LIVE wave 3 (presence ACTIVE + best-effort START, CAND-005 closed); StorePreview real |
| `terwo_system_monitor_hardware_telemetry` (+mobile activity) | MonitorPage (`/monitor`), CpuWave, Donut, NetPanel, ProcTable | Wave 1 wired + wave-2 per-row Kill (SIGTERM, dialog, authz server-side); no tracked dummies left on this screen |
| `terwo_file_manager_code_editor` (+mobile) | Files restyle, TabbedEditor, BulkBar, MountsCard | CRUD real; extras: PANEL ROOT card (path/rw/disk real, ACL string → CAND-016), wakelock card (battery ok? real-ish, else omit per P1), CLI Jump chips (real, navigate), toolbar (real), multi-select + bulk Archive/Download/Delete (real, client orchestration), search/sort (real client-side), Chmod column + per-file modes (→ CAND-016), mounts/shortcuts (→ CAND-019), symlink health (→ CAND-014), tabbed editor (real, no backend) + prettify/diff real (wave-10 live, CAND-033 closed; Prettier core set lazy-loaded, php/py/sql/sh honestly unsupported), type icons (Lucide map), footer counts (real) |
| `terwo_terminal_emulator` (+mobile) | Terminal restyle, tabs, keymap, macros | WS/session real; macros row real (wave-11 live: 6 presets + customs, one-tap send, destructive confirm, CAND-034 closed); extras: session header SHELL (real via greeting) + TTY (→ CAND-017), pty badge (real, inverse of pipe), WS latency (→ CAND-018), tabs + New Tab + per-tab procs (→ CAND-017), split button (→ CAND-017), font A-/bell/cursor (real xterm opts), MOTD neofetch (real static art + stats; kernel line → CAND-014), mobile keymap (exists — verify styling in P1) |
| `terwo_websites_reverse_proxy` (+mobile, +add modal) | Sites restyle, DeployModal, ProxySection, AppCards + stats | Type tabs + search + status filter (real client-side); per-card engine version + PID + CPU/memory live (wave-14 code, live gate pending box OOM) + 5 s poll; app CARDS not table (name, engine+version, PID, autorestart toggle → CAND-020, path, URL+open real, CPU/Memory → CAND-015 wave 14, actions start/stop/restart/log/settings/delete real except settings→verify navigates); nginx section: status + counts + reload real, proxy CRUD real, per-vhost SSL/toggles/edit/stats (→ CAND-021), master PID + conf path + syntax (→ CAND-021); add modal: engine cards + name/port/path real, Free port indicator (→ CAND-022), custom Startup Command (→ CAND-023); ports <1024 in mockup vs OLP 1024+ rule — rule wins, note in P1 (mockup shows :80/:443) |
| `terwo_database_manager` (+mobile) | Database restyle | Engine tabs mysql/postgres real + version line + New Database dialog + schema badges + DDL modal + data-vs-index (CAND-006/026 closed); Redis engine card stays CAND-024; import/export stays CAND-025 |
| `terwo_package_store_1_click_installer` (+mobile) | Store restyle + extras | Install cards + versions + conf/Configure + Update Repo + Batch Upgrade + mirror card real (wave-7 live, CAND-027 closed); per-env mirror → CAND-036, purge-cache out (confirm design), per-card service actions owned by services/database waves |
| `terwo_cron_task_scheduler` (+mobile) | Cron restyle + insights | CRUD + service + search/filter + crontab modal real; wave-5 live (dry-run modal, Run Now + last-run, countdown, stats footnoted panel-only, battery, daemon PID, CAND-028 closed); spool/category stay out (no source) |
| `terwo_backup_restore_manager` (+mobile) | Backup restyle + advanced | CRUD + stats + engines + filters real; wave-6 live (verify badges, gzip dumps, upload import, schedules with last-run, CAND-029 closed); full-system stays CAND-035 |
| `terwo_settings_system_preferences` (+mobile) | Settings restyle + sessions + server config + bind | Forms real; sessions table + per-session revoke + logout-others real (wave-8 live, CAND-030 closed; CSRF/zero-trust copy honestly dropped); server config real (wave-9 live: remember-me, verified badge, read-only bind + loopback badge, row expiry; PBKDF2 310k/rehash dropped with rationale; CAND-031 closed) + editable bind real (wave-13 live: file bind, validation, restart flow, fallback warning; CAND-037 closed); extras: export config JSON (real client-side download), saved toast (real), daemon reload + copy (real client-side) |
| `terwo_logo` | brand asset | real (self-host + rebrand) |

## P4 audit checklist (desktop `screen.png` + mobile width, agent pass 2026-10-11)

Method: every desktop + mobile `screen.png` viewed; code compared for
layout/copy/order; fixes landed as real-data upgrades only (no invented
values). Human pixel sign-off still required per spec §6. Remaining
mobile screens (database/websites/store/cron/backup/activity) follow the
verified shell + stacking patterns below — spot-check, don't re-audit.

- [x] shell: desktop rail + active block parity; mobile 6-tab bar
  (Dash/Web/Data/Files/Shell + contextual 6th) + More sheet with theme
  + logout; sticky wrap header. Verified on mobile dashboard/terminal/
  settings/files/login shots.
- [x] login: gateway stacking (grid → 1 col), honest placeholders,
  admin hint, GitHub link. Omitted: env strip, rate pill, subsystem
  health (no source). Light theme deferred (see below).
- [x] dashboard: type tabs + counts, path column, proxy link, store
  install shortcuts, conditional telegram card. Hero pills + card
  extras stay out (CAND-014/015).
- [x] monitor: structure matches (controls/meta/cards/dummies);
  TEMP header pill + per-core waves stay out (CAND-014).
- [x] files: bulk size, refresh, row highlight, editor meta + discard
  + caret, table scroll. Prettify/diff → CAND-033.
- [x] terminal: reconnect + exec input; tabs/split/TTY/latency/macros
  stay out (CAND-017/018/034).
- [x] websites: tab counts; PID/stats/autorestart/SSL stay out
  (CAND-015/020/021/022/023).
- [x] database: clear, table filter, db count, conn-string + copy.
  Row counts/DDL/export stay out (CAND-006/024/025/026).
- [x] store: tab counts; versions/commands/per-item ops stay out
  (CAND-027).
- [x] cron: cards + copy + crontab modal; categories replaced by
  status filter (no source field — documented); stats stay out
  (CAND-028).
- [x] backup: type tabs + search + order + coverage; CLI snippets +
  replication stay out (no `olp backup` CLI / rclone backend).
- [x] settings: strength meter, reload docs + copy; triggers/history/
  save-all/reset stay out (CAND-030/031).
- [ ] HUMAN: pixel sign-off desktop + one mobile width per screen.
- Known limits (not blockers): full light-mode palette (toggle flips
  `color-scheme`; component classes stay dark-first — needs a theme
  wave); `DataTable`/`EmptyState` unadopted (P5: adopt or drop);
  mobile card-style rows render as scrollable tables (no data loss).
