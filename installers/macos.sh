#!/bin/bash
# ============================================================
# OpenLocalPanel — macOS installer (launchd + Homebrew)
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/jhedev96/olp/main/installers/macos.sh | bash
#
# Reachable across the LAN (0.0.0.0); only use it on trusted networks
# with a strong password.
# Release note: replace the default repo URL below when publishing.
# ============================================================
set -e

REPO_URL="${OLP_REPO_URL:-https://github.com/jhedev96/olp.git}"
TARGET_DIR="${OLP_DIR:-$HOME/olp}"
APP_NAME="olp"

echo "=== OpenLocalPanel — macOS installer ==="
echo ""

# 1. Node.js (>= 22.12 per ADR-001) & git via Homebrew
if ! command -v brew >/dev/null 2>&1; then
  echo "ERROR: Homebrew is required but not installed."
  echo "Install it from https://brew.sh first, then re-run this script."
  exit 1
fi
if command -v node >/dev/null 2>&1 && node -e "process.exit(process.versions.node < '22.12' ? 1 : 0)"; then
  echo "[1/5] Node.js already installed: $(node -v)"
else
  echo "[1/5] Installing Node.js & git..."
  brew install node git
fi
if ! command -v git >/dev/null 2>&1; then
  echo "[1/5] Installing git..."
  brew install git
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

# 4. Service setup via the olp CLI (launchd plist, best-effort — see ADR-003)
echo "[4/5] Installing launchd service..."
node cli/dist/cli.js install

# 5. Start + show access info
echo "[5/5] Starting OpenLocalPanel..."
node cli/dist/cli.js start
node cli/dist/cli.js status || true

echo ""
echo "=== OpenLocalPanel is now running as a user service! ==="
echo ""
echo "Open on this machine: http://127.0.0.1:8080"
LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')
[ -n "$LAN_IP" ] && echo "Open from other PCs : http://$LAN_IP:8080"
echo ""
echo "First-run credentials print once when the service starts."
echo "Launchd support is best-effort in v2.0 — report macOS issues upstream."
echo ""
echo "Useful commands:"
echo "  node $TARGET_DIR/cli/dist/cli.js status  # service status"
echo "  node $TARGET_DIR/cli/dist/cli.js logs     # view panel logs"
