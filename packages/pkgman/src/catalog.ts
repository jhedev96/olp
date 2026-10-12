import type { EnvId } from '@olp/env-core';

/**
 * One installable package. `install` maps environments to shell commands;
 * a missing environment means "unavailable here" (never a guessed command).
 * `checks` overrides the presence probe per environment; `forcedEnvs`
 * marks environments where the item is assumed present (check skipped).
 */
export interface CatalogItem {
  id: string;
  name: string;
  desc: string;
  check?: string;
  bin?: string;
  checks?: Partial<Record<EnvId, string>>;
  forcedEnvs?: readonly EnvId[];
  install: Partial<Record<EnvId, string>>;
  /**
   * Full shell snippet printing the installed version (server uses the
   * first stdout line, capped). Absent → derived from `bin`
   * (`<bin> --version 2>&1 | head -n 1`); items with no usable probe
   * resolve to `null` at runtime (honest unknown, never a guess).
   */
  versionCmd?: string;
  /**
   * Static conf file path shown on the card (display only, never
   * executed; may contain `$PREFIX`/`$HOME`). Absent → no Configure
   * button (honest omission, not a dead link).
   */
  conf?: string;
}

const PROBE = (bin: string): string => `command -v ${bin} >/dev/null 2>&1`;
/** First-line version probe derived from a binary (`--version` shape). */
const VPROBE = (bin: string): string => `${bin} --version 2>&1 | head -n 1`;
const APT = (pkg: string): string => `apt-get update && apt-get install -y ${pkg}`;
const PACMAN = (pkg: string): string => `pacman -S --noconfirm --needed ${pkg}`;
const APK = (pkg: string): string => `apk add ${pkg}`;
const DNF = (pkg: string): string => `dnf install -y ${pkg}`;
const BREW = (pkg: string): string => `brew install ${pkg}`;
const NPMG = (pkg: string): string => `npm install -g ${pkg}`;
const NVM_INSTALL = 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash';
const BUN_INSTALL = 'curl -fsSL https://bun.sh/install | bash';
const HERMES_INSTALL = 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash';
const NODE_SOURCE_22 = 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs';

/**
 * The full catalog, sorted by `id`. Termux commands are verbatim Terwo
 * parity; other environments are best-effort verified mappings, with
 * unknown cells left absent (`tbd-verify`, see spec appendix).
 */
export const CATALOG: readonly CatalogItem[] = [
  { id: '9router', name: '9Router', desc: 'AI model gateway (OpenAI-compatible)', bin: '9router',
    install: { termux: NPMG('9router'), debian: NPMG('9router'), arch: NPMG('9router'), alpine: NPMG('9router'), fedora: NPMG('9router'), rhel: NPMG('9router'), macos: NPMG('9router'), wsl2: NPMG('9router'), windows: NPMG('9router') } },
  { id: 'bun', name: 'Bun', desc: 'Fast JS runtime',
    check: `${PROBE('bun')} || [ -f "$HOME/.bun/bin/bun" ]`,
    install: { termux: BUN_INSTALL, debian: BUN_INSTALL, arch: BUN_INSTALL, alpine: BUN_INSTALL, fedora: BUN_INSTALL, rhel: BUN_INSTALL, macos: BUN_INSTALL, wsl2: BUN_INSTALL, windows: 'powershell -c "irm bun.sh/install.ps1|iex"' } },
  { id: 'cloudflared', name: 'Cloudflared', desc: 'Cloudflare Tunnel', bin: 'cloudflared',
    conf: '~/.cloudflared/config.yml',
    install: { termux: 'pkg install -y cloudflared', macos: BREW('cloudflared') } },
  { id: 'composer', name: 'Composer', desc: 'Package manager PHP', bin: 'composer',
    install: { termux: 'pkg install -y composer', debian: APT('composer'), arch: PACMAN('composer'), alpine: APK('composer'), fedora: DNF('composer'), macos: BREW('composer') } },
  { id: 'cronie', name: 'Cronie', desc: 'Cron daemon (scheduled jobs)', bin: 'crond',
    checks: { debian: PROBE('cron'), macos: PROBE('cron') },
    install: { termux: 'pkg install -y cronie', debian: APT('cron'), arch: PACMAN('cronie'), fedora: DNF('cronie'), rhel: DNF('cronie') } },
  { id: 'ffmpeg', name: 'FFmpeg', desc: 'Video & audio processing', bin: 'ffmpeg',
    versionCmd: 'ffmpeg -version 2>&1 | head -n 1',
    install: { termux: 'pkg install -y ffmpeg', debian: APT('ffmpeg'), arch: PACMAN('ffmpeg'), alpine: APK('ffmpeg'), macos: BREW('ffmpeg') } },
  { id: 'git', name: 'Git', desc: 'Version control system', bin: 'git',
    conf: '~/.gitconfig',
    install: { termux: 'pkg install -y git', debian: APT('git'), arch: PACMAN('git'), alpine: APK('git'), fedora: DNF('git'), rhel: DNF('git'), macos: BREW('git') } },
  { id: 'golang', name: 'Go', desc: 'Go programming language', bin: 'go',
    versionCmd: 'go version 2>&1 | head -n 1',
    install: { termux: 'pkg install -y golang', debian: APT('golang'), arch: PACMAN('go'), alpine: APK('go'), fedora: DNF('golang'), rhel: DNF('golang'), macos: BREW('go') } },
  { id: 'hermes', name: 'Hermes Agent', desc: 'AI coding agent CLI', bin: 'hermes',
    install: { termux: HERMES_INSTALL, debian: HERMES_INSTALL, arch: HERMES_INSTALL, alpine: HERMES_INSTALL, fedora: HERMES_INSTALL, rhel: HERMES_INSTALL, macos: HERMES_INSTALL, wsl2: HERMES_INSTALL } },
  { id: 'mysql', name: 'MySQL (MariaDB)', desc: 'Database server MySQL', bin: 'mysqld',
    conf: '$PREFIX/etc/mysql/my.cnf',
    install: { termux: 'pkg install -y mariadb', debian: APT('mariadb-server'), arch: PACMAN('mariadb'), alpine: APK('mariadb mariadb-client'), fedora: DNF('mariadb-server'), rhel: DNF('mariadb-server'), macos: BREW('mariadb') } },
  { id: 'nginx', name: 'Nginx', desc: 'Web server & reverse proxy', bin: 'nginx',
    versionCmd: 'nginx -v 2>&1 | head -n 1',
    conf: '$PREFIX/etc/nginx/nginx.conf',
    install: { termux: 'pkg install -y nginx', debian: APT('nginx'), arch: PACMAN('nginx'), alpine: APK('nginx'), fedora: DNF('nginx'), rhel: DNF('nginx'), macos: BREW('nginx') } },
  { id: 'nodejs', name: 'Node.js', desc: 'Runtime JavaScript', bin: 'node', forcedEnvs: ['termux'],
    install: { termux: 'pkg install -y nodejs', debian: NODE_SOURCE_22, arch: PACMAN('nodejs'), alpine: APK('nodejs'), fedora: DNF('nodejs'), rhel: DNF('nodejs'), macos: BREW('node') } },
  { id: 'nvm', name: 'NVM', desc: 'Node Version Manager', check: '[ -f "$HOME/.nvm/nvm.sh" ]',
    // Unverified on-device (no nvm on the Linux spike box): standard
    // source-and-query snippet; runtime failure maps to honest null.
    versionCmd: 'bash -c \'source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && nvm --version\' 2>&1 | head -n 1',
    install: { termux: NVM_INSTALL, debian: NVM_INSTALL, arch: NVM_INSTALL, alpine: NVM_INSTALL, fedora: NVM_INSTALL, rhel: NVM_INSTALL, macos: NVM_INSTALL, wsl2: NVM_INSTALL } },
  { id: 'openssh', name: 'OpenSSH', desc: 'SSH server & client (sshd port 8022)', bin: 'sshd',
    versionCmd: 'ssh -V 2>&1 | head -n 1',
    conf: '~/.ssh/authorized_keys',
    install: { termux: 'pkg install -y openssh', debian: APT('openssh-server'), arch: PACMAN('openssh'), alpine: APK('openssh'), fedora: DNF('openssh-server'), rhel: DNF('openssh-server'), macos: BREW('openssh') } },
  { id: 'php', name: 'PHP', desc: 'Interpreter PHP', bin: 'php',
    install: { termux: 'pkg install -y php', debian: APT('php'), arch: PACMAN('php'), alpine: APK('php'), fedora: DNF('php'), rhel: DNF('php'), macos: BREW('php') } },
  { id: 'pm2', name: 'PM2', desc: 'Process manager Node.js', bin: 'pm2',
    install: { termux: NPMG('pm2'), debian: NPMG('pm2'), arch: NPMG('pm2'), alpine: NPMG('pm2'), fedora: NPMG('pm2'), rhel: NPMG('pm2'), macos: NPMG('pm2'), wsl2: NPMG('pm2'), windows: NPMG('pm2') } },
  { id: 'postgres', name: 'PostgreSQL', desc: 'Database server PostgreSQL', bin: 'postgres',
    install: { termux: 'pkg install -y postgresql', debian: APT('postgresql'), arch: PACMAN('postgresql'), alpine: APK('postgresql postgresql-client'), fedora: DNF('postgresql-server'), rhel: DNF('postgresql-server'), macos: BREW('postgresql') } },
  { id: 'python', name: 'Python', desc: 'Interpreter Python', bin: 'python',
    checks: { debian: PROBE('python3') },
    versionCmd: '(python --version 2>&1 || python3 --version 2>&1) | head -n 1',
    install: { termux: 'pkg install -y python', debian: APT('python3'), arch: PACMAN('python'), alpine: APK('python3'), fedora: DNF('python3'), rhel: DNF('python3'), macos: BREW('python') } },
  { id: 'redis', name: 'Redis', desc: 'In-memory database & cache', bin: 'redis-server',
    install: { termux: 'pkg install -y redis', debian: APT('redis-server'), arch: PACMAN('redis'), alpine: APK('redis'), fedora: DNF('redis'), rhel: DNF('redis'), macos: BREW('redis') } },
  { id: 'rsync', name: 'Rsync', desc: 'File sync & backup', bin: 'rsync',
    install: { termux: 'pkg install -y rsync', debian: APT('rsync'), arch: PACMAN('rsync'), alpine: APK('rsync'), fedora: DNF('rsync'), rhel: DNF('rsync') } },
  { id: 'sqlite', name: 'SQLite', desc: 'Lightweight serverless database', bin: 'sqlite3',
    install: { termux: 'pkg install -y sqlite', debian: APT('sqlite3'), arch: PACMAN('sqlite'), alpine: APK('sqlite'), fedora: DNF('sqlite'), rhel: DNF('sqlite') } },
  { id: 'termux-api', name: 'Termux:API', desc: 'Phone sensors & features (battery, notifications)', bin: 'termux-battery-status',
    install: { termux: 'pkg install -y termux-api' } },
  { id: 'tmux', name: 'Tmux', desc: 'Terminal multiplexer', bin: 'tmux',
    versionCmd: 'tmux -V 2>&1 | head -n 1',
    conf: '~/.tmux.conf',
    install: { termux: 'pkg install -y tmux', debian: APT('tmux'), arch: PACMAN('tmux'), alpine: APK('tmux'), fedora: DNF('tmux'), rhel: DNF('tmux'), macos: BREW('tmux') } },
  { id: 'unzip', name: 'Unzip', desc: 'Extract ZIP (used by file manager & backup)', bin: 'unzip',
    install: { termux: 'pkg install -y unzip', debian: APT('unzip'), arch: PACMAN('unzip'), alpine: APK('unzip'), fedora: DNF('unzip'), rhel: DNF('unzip') } },
  { id: 'yt-dlp', name: 'yt-dlp', desc: 'Video & audio downloader', bin: 'yt-dlp',
    install: { termux: 'pkg install -y yt-dlp', debian: APT('yt-dlp'), arch: PACMAN('yt-dlp'), alpine: APK('yt-dlp'), fedora: DNF('yt-dlp'), macos: BREW('yt-dlp') } },
  { id: 'zip', name: 'Zip', desc: 'ZIP archives (used by file manager & backup)', bin: 'zip',
    // Info-ZIP prints the license on line 1; the version sits on line 2
    // (spike-verified: "This is Zip 3.0 ...").
    versionCmd: 'zip -v 2>&1 | head -n 2 | tail -n 1',
    install: { termux: 'pkg install -y zip', debian: APT('zip'), arch: PACMAN('zip'), alpine: APK('zip'), fedora: DNF('zip'), rhel: DNF('zip') } },
];

/** Find an item by id (exact match). */
export function itemById(id: string): CatalogItem | undefined {
  return CATALOG.find((item) => item.id === id);
}

/** True when the item is assumed present on `env` (presence probe skipped). */
export function isForced(item: CatalogItem, env: EnvId): boolean {
  return item.forcedEnvs?.includes(env) ?? false;
}

/**
 * Resolve the install command for an environment.
 * Absent cells are honest unavailability, never guesses.
 */
export function installCommand(
  item: CatalogItem,
  env: EnvId,
): { ok: true; cmd: string } | { ok: false; reason: string } {
  const cmd = item.install[env];
  if (cmd === undefined) return { ok: false, reason: `Install command unavailable for ${env} (${item.id})` };
  return { ok: true, cmd };
}

/** Presence probe for an environment, or `null` when assumed present. */
export function checkCommand(item: CatalogItem, env: EnvId): string | null {
  if (isForced(item, env)) return null;
  const override = item.checks?.[env];
  if (override !== undefined) return override;
  if (item.check !== undefined) return item.check;
  if (item.bin !== undefined) return PROBE(item.bin);
  return 'exit 1';
}

/**
 * Version probe for an item (explicit `versionCmd` or `--version`
 * derived from `bin`), or `null` when the item has neither (e.g. nvm
 * without its snippet would be unprobable — honest unknown).
 * The server caps output to the first line and maps failures to null.
 */
export function versionCommand(item: CatalogItem): string | null {
  if (item.versionCmd !== undefined) return item.versionCmd;
  if (item.bin !== undefined) return VPROBE(item.bin);
  return null;
}

/**
 * Repo-index refresh per environment (sudo-free, same privilege model
 * as installs: the server user owns the package manager).
 * Absent cells are honest unavailability, never guesses.
 */
const UPDATE: Partial<Record<EnvId, string>> = {
  termux: 'pkg update',
  debian: 'apt-get update',
  wsl2: 'apt-get update',
  arch: 'pacman -Sy',
  alpine: 'apk update',
  fedora: 'dnf makecache',
  rhel: 'dnf makecache',
  macos: 'brew update',
};

/**
 * Full upgrade-all per environment (one manager-native command, never
 * a per-item reinstall loop).
 */
const UPGRADE: Partial<Record<EnvId, string>> = {
  termux: 'pkg upgrade -y',
  debian: 'apt-get upgrade -y',
  wsl2: 'apt-get upgrade -y',
  arch: 'pacman -Su --noconfirm',
  alpine: 'apk upgrade',
  fedora: 'dnf upgrade -y',
  rhel: 'dnf upgrade -y',
  macos: 'brew upgrade',
};

/** Repo refresh command for an environment. */
export function updateCommand(env: EnvId): { ok: true; cmd: string } | { ok: false; reason: string } {
  const cmd = UPDATE[env];
  if (cmd === undefined) return { ok: false, reason: `Repo update unavailable for ${env}` };
  return { ok: true, cmd };
}

/** Upgrade-all command for an environment. */
export function upgradeCommand(env: EnvId): { ok: true; cmd: string } | { ok: false; reason: string } {
  const cmd = UPGRADE[env];
  if (cmd === undefined) return { ok: false, reason: `Batch upgrade unavailable for ${env}` };
  return { ok: true, cmd };
}
