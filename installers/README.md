# Installers — OpenLocalPanel (OLP)

One-line installs. Every script follows the same 5 steps (check → fetch →
deps → service → start) and honors `OLP_REPO_URL` / `OLP_DIR` overrides.
All scripts must pass `bash -n` (CI gate).

> Release note: default repo URLs below are placeholders — replace with
> the published repo URL before release.

## Termux (Android, pm2)

```bash
curl -sL https://raw.githubusercontent.com/openlocalpanel/olp/main/installers/termux.sh | bash
```

Auto-start on reboot: install the Termux:Boot app, create
`~/.termux/boot/olp.sh` with `termux-wake-lock` + `pm2 resurrect`, then
`chmod +x ~/.termux/boot/olp.sh`.

## Debian / Ubuntu (systemd, needs root)

```bash
curl -sL https://raw.githubusercontent.com/openlocalpanel/olp/main/installers/debian.sh | bash
```

Node.js 22 comes from NodeSource (distro packages are too old — see
ADR-001). Manage via `systemctl {status,restart} olp`.

## Arch Linux (systemd, needs root)

```bash
curl -sL https://raw.githubusercontent.com/openlocalpanel/olp/main/installers/arch.sh | bash
```

Rolling Node.js tracks current — always above the floor.

## Alpine Linux (OpenRC, needs root)

```bash
curl -sL https://raw.githubusercontent.com/openlocalpanel/olp/main/installers/alpine.sh | sh
```

musl note: the terminal runs in pipe mode (no `node-pty` build).

## Fedora / RHEL (systemd + firewalld, needs root)

```bash
curl -sL https://raw.githubusercontent.com/openlocalpanel/olp/main/installers/fedora.sh | bash
```

Open port 8080 with `firewall-cmd` (printed by the installer), and check
SELinux audit logs on denials.

## macOS (launchd + Homebrew, best-effort in v2.0)

```bash
curl -sL https://raw.githubusercontent.com/openlocalpanel/olp/main/installers/macos.sh | bash
```

Requires Homebrew up front (the script refuses without it).

## Security posture (all installers)

- Binds `0.0.0.0` (LAN-reachable, Terwo parity) — trusted WiFi only.
- Change the first-run credentials immediately via Settings.
- Never expose the panel directly to the public internet; use an SSH
  tunnel or Cloudflare Tunnel for remote access.
