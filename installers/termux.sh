#!/bin/bash
# ============================================================
# OpenLocalPanel — Termux installer (pm2-based, Terwo parity)
#
# Usage (in Termux):
#   curl -sL https://raw.githubusercontent.com/jhedev96/olp/main/installers/termux.sh | bash
#
# After install, the panel runs in the background via PM2 — no need
# to keep a terminal open. Reachable across the LAN (0.0.0.0);
# only use it on trusted WiFi with a strong password.
# Release note: replace the default repo URL below when publishing.
# ============================================================
set -e

REPO_URL="${OLP_REPO_URL:-https://github.com/jhedev96/olp.git}"
TARGET_DIR="${OLP_DIR:-$HOME/olp}"
APP_NAME="olp"

echo "=== OpenLocalPanel — Termux installer ==="
echo ""

# 1. Node.js & git (>= 22.12 per ADR-001)
if command -v node >/dev/null 2>&1; then
  echo "[1/5] Node.js already installed: $(node -v)"
else
  echo "[1/5] Installing Node.js & git..."
  pkg update -y
  pkg install -y nodejs git
fi
if ! command -v git >/dev/null 2>&1; then
  echo "[1/5] Installing git..."
  pkg install -y git
fi
if ! node -e "process.exit(process.versions.node < '22.12' ? 1 : 0)"; then
  echo "ERROR: Node.js >= 22.12 required (found $(node -v)). Upgrade Termux packages and retry."
  exit 1
fi

# 2. Download / update panel
echo "[2/5] Downloading panel from GitHub..."
if [ -d "$TARGET_DIR/.git" ]; then
  echo "      Folder exists, updating to latest version..."
  git -C "$TARGET_DIR" pull --ff-only || true
elif [ -d "$TARGET_DIR" ]; then
  echo "      Folder $TARGET_DIR exists (not a git repo), using it as-is."
else
  git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
fi

# 3. Dependencies + build (lockfile-committed; install fallback for dirty trees).
#    Full install first: the TypeScript build needs devDeps (@types, tsc).
#    Pruned after the build for runtime footprint.
echo "[3/5] Installing dependencies..."
cd "$TARGET_DIR"
if npm ci --no-audit --no-fund 2>/dev/null; then
  echo "      Installed from lockfile."
else
  echo "      Lockfile out of sync, falling back to npm install..."
  npm install --no-audit --no-fund
fi
echo "      Building (packages before apps)..."
npm run build
echo "      Pruning dev dependencies..."
npm prune --omit=dev --no-audit --no-fund

# 4. PM2 (process manager — keeps it running in background)
echo "[4/5] Setting up PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
  echo "      Installing PM2..."
  npm install -g pm2
fi

# 5. Run in background + save process list (LAN-reachable like Terwo)
echo "[5/5] Starting OpenLocalPanel in background..."
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
PANEL_HOST=0.0.0.0 pm2 start apps/server/dist/index.js --name "$APP_NAME"
pm2 save >/dev/null

echo ""
echo "=== OpenLocalPanel is now running in the background! ==="
echo ""
# Show the credential box from logs (only appears on first install)
sleep 2
CREDS=$(pm2 logs "$APP_NAME" --lines 60 --nostream 2>/dev/null | grep -A7 "username" | head -9 || true)
if [ -n "$CREDS" ]; then
  echo "$CREDS"
  echo ""
fi
echo "Open on this phone  : http://127.0.0.1:8080"
LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')
[ -n "$LAN_IP" ] && echo "Open from other PCs : http://$LAN_IP:8080"
echo ""
echo "Useful commands:"
echo "  pm2 logs olp     # view panel logs"
echo "  pm2 restart olp  # restart panel"
echo "  pm2 stop olp     # stop panel"
echo ""
echo "To auto-start on every phone reboot: install the Termux:Boot app,"
echo "then create ~/.termux/boot/olp.sh containing:"
echo "  #!/data/data/com.termux/files/usr/bin/sh"
echo "  export PATH=\$PATH:/data/data/com.termux/files/usr/bin"
echo "  termux-wake-lock"
echo "  pm2 resurrect"
echo "Don't forget: chmod +x ~/.termux/boot/olp.sh"
