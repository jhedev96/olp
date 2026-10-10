# SPEC — installers

> Module id: `installers` (`installers/*.sh`, thin wrappers over the `olp` CLI).
> Owner: TBD. Status: DRAFT.
> Depends on: CLI `install` (locked), services units (locked), ADR-001 Node
> baseline (locked), pkgman privilege follow-up (open — scripts assume a
> privileged-enough user, same as below).
> Gate: approve before any installer ships.

## 1. Objective

Replace the Termux-only `terwo/install.sh` (92 lines: node+git check,
clone-or-pull, `npm install`, pm2 setup, background start, credential
scrape, LAN IP, Termux:Boot notes) with one small script per supported
OS that bootstraps Node.js, fetches OLP, installs deps, and delegates
service setup to `olp install` — so every environment gets the same
5-step flow with zero duplicated supervision logic.

Success: copy-paste one-liner per OS in the README; each script passes
`bash -n`; Termux flow stays pm2-based (parity); systemd distros end
with an enabled service; dry-run reviewable without execution.

## 2. API Contract (shell)

```bash
# Every installer honors:
OLP_REPO=${OLP_REPO_URL:-<default git url>}   # override source (Terwo PANEL_REPO_URL parity)
OLP_DIR=${OLP_DIR:-<default dir>}             # override target (Terwo PANEL_DIR parity)
APP_NAME="olp"                                 # was "terwo"

# Common 5-step shape (Terwo parity):
# [1/5] Node.js (>=22.12 per ADR-001) + git   — per-OS bootstrap, skips when present
# [2/5] clone --depth 1 | pull --ff-only      — same three-branch logic as Terwo
# [3/5] npm ci --omit=dev --no-audit --no-fund (lockfile-committed; `install` only on legacy paths)
# [4/5] node cli/dist/cli.js install          — delegates to `olp install` (units + enable)
# [5/5] start + credentials + LAN IP + next-commands (same UX block as Terwo)
```

### Behavior

- `set -e` (Terwo parity; `-u`/`pipefail` where safe per shell — Termux
  `sh` compat noted per script).
- Step 1 per OS: Termux `pkg update && pkg install -y nodejs git`;
  Debian/Ubuntu NodeSource 22.x setup + `apt-get install -y nodejs git`;
  Arch `pacman -Sy --needed nodejs git` (fresh-db safe); Alpine
  `apk add nodejs git`; Fedora/RHEL `dnf install -y nodejs git`; macOS
  `brew install node git` (missing brew → actionable error, no auto-install).
- Node floor enforced: `node -e "process.exit(process.versions.node < '22.12' ? 1 : 0)"`-style gate with an upgrade hint (string compare works for semver here; documented).
- Step 4 Termux keeps pm2 verbatim (`pm2 delete/start/save`, app name
  `olp`, `PANEL_HOST=0.0.0.0`); other OSes run `olp install` (which emits
  native units) — pm2 stays Termux-only per services §9.
- Step 5 prints the first-run credential box by scraping service logs
  (`pm2 logs --nostream` on Termux, `journalctl -u olp` note elsewhere),
  the `127.0.0.1:8080` URL, the LAN IP via `ip route get` (best-effort,
  Terwo parity), and per-OS manage commands.
- Bind posture: installers keep Terwo's LAN-reachable default
  (`PANEL_HOST=0.0.0.0`) with the trusted-WiFi warning verbatim in
  spirit (English) — changing the default is a separate human decision.
- Re-run safe (idempotent): existing checkout pulls `--ff-only`,
  existing service deleted/recreated, `olp install` overwrites units.

## 3. Commands

```bash
Check: bash -n installers/<os>.sh        # syntax gate (CI)
Lint:  shellcheck installers/<os>.sh     # when available (warning-only until adopted)
```

## 4. Project Structure

```text
installers/
  termux.sh debian.sh arch.sh alpine.sh fedora.sh macos.sh
  README.md  # one-liners + per-OS notes (Termux:Boot, sudo, brew)
```

## 5. Code Style

```bash
# Good: env overrides first, numbered steps echoing Terwo, no silent curl|bash requirements beyond the one-liner.
set -e
OLP_DIR="${OLP_DIR:-$HOME/olp}"
echo "[2/5] Downloading OLP..."
```

- English comments/echoes; `set -e`; quote all expansions.

## 6. Testing Strategy

- `bash -n` syntax gate on every script (CI, zero deps).
- Review matrix (human): per OS, dry-read each step against a fresh
  container/VM; Termux + Debian live-smoked by a human before release
  (ADR-003: no Termux CI exists).
- Shellcheck clean as aspiration (not gate until baseline fixed).

## 7. Boundaries

- Always: idempotent re-runs; env overrides; trusted-WiFi warning.
- Ask first: changing the default bind; adding distros; auto-`sudo`.
- Never: `curl | bash` beyond the documented one-liner; hardcode home
  dirs (use `$HOME`); commit per-OS secrets.

## 8. Success Criteria

- [ ] Six scripts pass `bash -n`; Termux + Debian live-smoked end to end
  (panel reachable, credentials shown, reboot story documented).
- [ ] README one-liners per OS + privilege notes (sudo/root/brew).

## 9. Open Questions

- Default bind stays `0.0.0.0` (Terwo parity) vs localhost-first?
  Proposal: keep parity for v2.0, revisit with a security pass.
- `npm ci` vs `npm install` on user-modified checkouts (Terwo used
  `install`; `ci` fails on lockfile drift — document `install` fallback).

## 10. Decisions

- Installers wrap `olp install`; supervision logic lives in CLI/services,
  never duplicated in shell.

## 11. Parity mapping (§9.2)

| Terwo (`install.sh:line`) | OLP | Mark |
|---|---|---|
| header/usage/one-liner `:1-13` | per-OS headers same shape | parity |
| env overrides `:16-19` | `OLP_REPO_URL`/`OLP_DIR` same | parity (renamed) |
| node+git check `:24-35` | per-OS bootstrap, same skip-if-present | parity |
| clone/pull 3-branch `:37-46` | same | parity |
| deps `:48-52` | `npm ci` (lockfile) | deviation (reproducible; `install` fallback documented) |
| pm2 setup `:54-65` | Termux identical; others → `olp install` | parity/deviation per OS (recorded) |
| creds scrape `:70-76` | same via pm2/journalctl note | parity |
| LAN IP + commands + Boot notes `:77-92` | same UX block per OS | parity |
