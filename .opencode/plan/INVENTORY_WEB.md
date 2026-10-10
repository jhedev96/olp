# INVENTORY_WEB — mockup → components → features matrix

> Source: `mockup/stitch_terwo_ui_redesign/` (27 screens: desktop + mobile
> pairs, modals, logo). Shell rows verified by grep 2026-10-10; per-screen
> detail fills in during P0 (each row needs a `code.html` read, not a grep).
> Verdicts: `real` (backend ready) | `dummy` (+CANDIDATE id) |
> `new-backend` (+CANDIDATE id, built as dummy now).

## Shell (verified, all desktop screens)

| Element | Mockup evidence | Target component | Verdict |
|---|---|---|---|
| Sidebar nav (Dashboard, Website, Database, Files, Terminal, Store, Cron, Backup, Settings) | nav labels in every desktop `code.html` | `components/shell/Sidebar.tsx` | real (router exists) |
| Monitor nav entry | monitor screens exist; no slug yet | Sidebar + new `/monitor` route | real (new slug, locked) |
| Brand block (name, version, env badge, host) | `Terwo/v1.13.0/Termux Online/:8080/HOST` markers | `BrandBlock.tsx` | real (rebrand to OLP in P0) |
| Dark toggle + logout | `dark_mode`, `logout` markers | Sidebar | real (theme + logout exist) |
| Header (title, host badge) | per-screen headers | `components/shell/Header.tsx` | real (P0 details) |
| Material → Lucide map | icon names per screen | recorded per row below | real (no new dep) |
| Self-hosted logo | `terwo_logo/` + lh3 hotlinks (must go) | `assets/logo.*` | real (rebrand asset) |

## Screens (detail: P0 — one subtask per row group)

| Screen (folder) | Components | Features → verdict |
|---|---|---|
| `terwo_login_auth_gateway` (+mobile) | LoginPage restyle | TBD P0 (form exists; rebrand + shell-less layout) |
| `terwo_dashboard_revisi` (+mobile, +light) | Dashboard restyle, ServicesDaemons, StorePreview | TBD P0 (cards real; services → CAND-005) |
| `terwo_system_monitor_hardware_telemetry` (+mobile activity) | MonitorPage (new `/monitor`), CpuWave, Donut, NetPanel, ProcTable | Mostly CAND-001..004; exact split TBD P0 |
| `terwo_file_manager_code_editor` (+mobile) | Files restyle, EditorModal | TBD P0 (CRUD real) |
| `terwo_terminal_emulator` (+mobile) | Terminal restyle | TBD P0 (WS exists; keymap parity check) |
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
