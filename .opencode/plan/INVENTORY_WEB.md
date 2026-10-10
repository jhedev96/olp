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
| `terwo_login_auth_gateway` (+mobile) | LoginPage restyle | TBD P0 (form exists; rebrand + shell-less layout) |
| `terwo_dashboard_revisi` (+mobile, +light) | Dashboard restyle, ServicesDaemons, StorePreview, LiveLog | Cards: real (loadavg/cores/mem/disk/battery/uptime all exist); extras → dummies: CPU temp, per-core freq, ZRAM/swap, disk FS type, battery temp/wakelock/power, PM2 badge, per-site memory+engine version, open-site links real; header buttons: restart-panel → CAND-015, web-terminal/new-website real (navigate); LiveLog panel → CAND-013; Services section → CAND-005; StorePreview real (26 items) |
| `terwo_system_monitor_hardware_telemetry` (+mobile activity) | MonitorPage (`/monitor`), CpuWave, Donut, NetPanel, ProcTable | Mostly dummy: CPU cluster card mixed (model/kernel/arch/wakelock → CAND-014, uptime real); per-cluster wave → CAND-014 + frontend history buffer; donut segments → CAND-014; disk rates → CAND-014; network ifaces/sockets → CAND-002; proc table + restart → CAND-001; kill → CAND-004; refresh cadence/pause/export → real (client-side); top Kill Task → verify P0 (likely scroll action, else CAND-004) |
| `terwo_file_manager_code_editor` (+mobile) | Files restyle, TabbedEditor, BulkBar, MountsCard | CRUD real; extras: PANEL ROOT card (path/rw/disk real, ACL string → CAND-016), wakelock card (battery ok? real-ish, else omit per P1), CLI Jump chips (real, navigate), toolbar (real), multi-select + bulk Archive/Download/Delete (real, client orchestration), search/sort (real client-side), Chmod column + per-file modes (→ CAND-016), mounts/shortcuts (→ CAND-019), symlink health (→ CAND-014), tabbed editor (real, no backend), type icons (Lucide map), footer counts (real) |
| `terwo_terminal_emulator` (+mobile) | Terminal restyle, tabs, keymap | WS/session real; extras: session header SHELL (real via greeting) + TTY (→ CAND-017), pty badge (real, inverse of pipe), WS latency (→ CAND-018), tabs + New Tab + per-tab procs (→ CAND-017), split button (→ CAND-017), font A-/bell/cursor (real xterm opts), MOTD neofetch (real static art + stats; kernel line → CAND-014), mobile keymap (exists — verify styling in P1) |
| `terwo_websites_reverse_proxy` (+mobile, +add modal) | Sites restyle, DeployModal, ProxySection | TBD P0 (CRUD real) |
| `terwo_database_manager` (+mobile) | Database restyle | TBD P0 (browse real; create → CAND-006) |
| `terwo_package_store_1_click_installer` (+mobile) | Store restyle | TBD P0 (install real) |
| `terwo_cron_task_scheduler` (+mobile) | Cron restyle | TBD P0 (CRUD real) |
| `terwo_backup_restore_manager` (+mobile) | Backup restyle | TBD P0 (CRUD real; extras → CAND-007) |
| `terwo_settings_system_preferences` (+mobile) | Settings restyle | TBD P0 (forms real) |
| `terwo_logo` | brand asset | real (self-host + rebrand) |

## P4 audit checklist (fill per screen: mockup `screen.png` vs app)

- [ ] login, dashboard, monitor, files, terminal, website, database,
  store, cron, backup, settings (desktop + one mobile width each)
