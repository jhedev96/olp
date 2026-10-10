# Test drive — OpenLocalPanel (local)

Run the full panel on your own machine and click through it. No VPS,
no Termux needed — plain Linux/macOS/WSL2 with Node.js ≥ 22.12.

## 1. Install & build

```bash
git clone https://github.com/jhedev96/olp.git && cd olp
npm ci --no-audit --no-fund
npm run build
```

`npm run build` orders workspaces by dependency (packages before apps).
Never `npm ci --omit=dev` before building — `tsc` and `@types/*` live
in devDependencies.

## 2. Boot (throwaway data dir!)

```bash
mkdir -p /tmp/olp-try/data /tmp/olp-try/root
PANEL_PORT=8080 PANEL_HOST=127.0.0.1 \
  PANEL_ROOT=/tmp/olp-try/root OLP_DATA_DIR=/tmp/olp-try/data \
  node apps/server/dist/index.js
```

First boot prints one-time credentials — save them, then open
**http://127.0.0.1:8080** (redirects to `/login`).

| Env var | Default | Meaning |
|---|---|---|
| `PANEL_PORT` | `8080` | HTTP port |
| `PANEL_HOST` | `127.0.0.1` | Bind (keep localhost unless you need LAN) |
| `PANEL_ROOT` | `$HOME` | File-manager jail root |
| `OLP_DATA_DIR` | `~/.olp` | Auth/sites/db/settings storage |
| `OLP_WEB_DIR` | auto (`apps/web/dist`) | Override frontend build location |

## 3. Click-through checklist (10 slugs)

1. `/login` — wrong password shows the server message (no reload);
   correct login lands on `/dashboard` (full reload, cookie is HttpOnly).
2. `/dashboard` — 5 cards + sites table, refreshes every 5 s.
3. `/files` — mkdir/touch/rename/delete, upload, edit text, zip/unzip,
   image preview. Try `..` traversal (must 400).
4. `/terminal` — type `echo hi`; reload keeps history; New session
   respawns; pipe badge appears when `node-pty` is absent.
5. `/website` — add a Node/static site, start, open its port, read logs,
   stop, delete. Nginx section needs `nginx` installed (else honest 400).
6. `/database` — without a DB server, Test/Connect must fail with clear
   messages (no crash). With MariaDB/Postgres: browse + SQL.
7. `/store` — cards show installed state; install streams logs.
8. `/cron` — add/enable-disable/delete a `* * * * * echo hi` job
   (needs `crontab`; check `crontab -l` on the box).
9. `/backup` — folder backup → download → delete; DB dump needs a DB.
10. `/settings` — change username, test Telegram (needs bot token),
    change password (forces re-login).

## 4. Automated smoke (same flows, headless)

```bash
# server must already run (step 2), then in another shell:
SMOKE_BASE=http://127.0.0.1:8080 SMOKE_USER=<u> SMOKE_PASS=<p> \
  node smoke/linux.mjs
```

Expect `SMOKE ALL GREEN` (27 checks). Needs `ws` resolvable — run
`npm install` (full, not `--omit=dev`) first.

## 5. Troubleshooting

- `{"error":"Not logged in"}` — session expired (24 h) or server
  restarted (sessions are in-memory): log in again.
- `Backup name already taken` / port collisions — names and ports are
  unique by design; delete or pick another.
- `Install command unavailable for <env>` — that package has no
  verified command for your OS yet (see `packages/pkgman` tbd-verify).
- `node-pty` build failure at install — normal on musl/Android; the
  terminal transparently falls back to pipe mode.
