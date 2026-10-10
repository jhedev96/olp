# Migrate Terwo → OpenLocalPanel

Terwo stored everything under `~/.termux-panel/`; OLP uses `~/.olp/`.
On first boot OLP **auto-migrates** what it can and regenerates the rest.
This guide covers what transfers, what does not, and the recommended path.

## Automatic (first boot, no action needed)

| Terwo (`~/.termux-panel/`) | OLP (`~/.olp/`) | Notes |
|---|---|---|
| `config.json` (username/salt/hash) | `config.json` | Copied verbatim — **same login keeps working** |
| `db.json` (DB credentials) | `db.json` | Copied verbatim |
| `settings.json` (telegram) | `settings.json` | Copied verbatim (bot resumes polling) |
| `sites.json` (registry) | `sites.json` | Copied verbatim (processes do **not** transfer — start them again) |
| `nginx.json` (proxies) | `nginx.json` | Copied verbatim; confs regenerate on next change |

Running processes, sessions, install logs, and dead-log buffers are
memory-only in both systems and never migrate (re-login + restart sites).

## Recommended path (cleanest)

1. Install OLP alongside Terwo (different port, e.g. `PANEL_PORT=9000`).
2. Log in with your Terwo credentials (auto-migrated) and verify.
3. Re-create `~/.termux/boot/olp.sh` (Termux:Boot) or enable the native
   service, then stop Terwo (`pm2 stop terwo`).
4. Delete `~/.termux-panel/` only after a week of smooth running.

## Fresh start (alternative)

Delete (or move aside) `~/.termux-panel/` before first boot: OLP
generates first-run credentials and prints them once to the service log.

## Rollback

Your Terwo checkout and `~/.termux-panel/` are untouched by the OLP
installer (different directory). `pm2 resurrect` brings Terwo back;
keep its Termux:Boot entry until you are confident.
