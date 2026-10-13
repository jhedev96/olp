import type { EnvId } from '@olp/env-core';

/**
 * Mirror source descriptor per environment. `file`/`dir` are
 * prefix-relative on Termux (`underPrefix`) and absolute elsewhere.
 * Server composes candidate paths; first parse hit wins.
 */
export interface MirrorSource {
  kind: 'apt' | 'pacman' | 'apk' | 'yum' | 'brew';
  file?: string;
  dir?: string;
  /** Suffix filter for directory scans (e.g. `.list`, `.repo`). */
  ext?: string;
  /** Join paths under `$PREFIX` (Termux only). */
  underPrefix?: boolean;
}

/**
 * Mirror source per environment (`null` = no detection here —
 * honest unknown, never a guess).
 */
export function mirrorSource(env: EnvId): MirrorSource | null {
  switch (env) {
    case 'termux':
      return { kind: 'apt', file: 'etc/apt/sources.list', dir: 'etc/apt/sources.list.d', ext: '.list', underPrefix: true };
    case 'debian':
    case 'wsl2':
      return { kind: 'apt', file: '/etc/apt/sources.list', dir: '/etc/apt/sources.list.d', ext: '.list' };
    case 'arch':
      return { kind: 'pacman', file: '/etc/pacman.d/mirrorlist' };
    case 'alpine':
      return { kind: 'apk', file: '/etc/apk/repositories' };
    case 'fedora':
    case 'rhel':
      return { kind: 'yum', dir: '/etc/yum.repos.d', ext: '.repo' };
    case 'macos':
      return { kind: 'brew' };
    default:
      return null;
  }
}

/**
 * Hostname from a URL (wave-7 rule, local copy — packages never
 * import from apps: non-empty, RFC chars, dot or colon required so
 * degenerate tokens never become displayed mirrors).
 */
function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    if (host !== '' && /^[a-z0-9.-]+$/i.test(host) && (host.includes('.') || host.includes(':'))) return host;
  } catch {
    // unparseable — fall through to null
  }
  return null;
}

/** First host from APT one-line (`deb …`) or DEB822 (`URIs:`) text. */
export function parseAptMirror(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    const oneLine = trimmed.match(/^deb\s+(\S+)/)?.[1];
    if (oneLine !== undefined) {
      const host = hostOf(oneLine);
      if (host !== null) return host;
    }
    const uriLine = trimmed.match(/^URIs:\s*(\S+)/)?.[1];
    if (uriLine !== undefined) {
      const host = hostOf(uriLine);
      if (host !== null) return host;
    }
  }
  return null;
}

/** First host from a pacman `Server = …` mirrorlist. */
export function parsePacmanMirror(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    const url = trimmed.match(/^Server\s*=\s*(\S+)/)?.[1];
    if (url !== undefined) {
      const host = hostOf(url);
      if (host !== null) return host;
    }
  }
  return null;
}

/** First host from apk repositories (tags like `@edge` are skipped). */
export function parseApkMirror(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    for (const token of trimmed.split(/\s+/)) {
      if (!token.startsWith('http://') && !token.startsWith('https://')) continue;
      const host = hostOf(token);
      if (host !== null) return host;
    }
  }
  return null;
}

/**
 * First host from a yum `.repo` `baseurl`. `mirrorlist=`-only files
 * answer `null` (the metalink host is metainfo, not a package
 * mirror — claiming it would lie).
 */
export function parseYumMirror(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    const value = trimmed.match(/^baseurl\s*=\s*(.+)$/i)?.[1];
    if (value === undefined) continue;
    for (const token of value.split(/[\s,]+/)) {
      if (token === '') continue;
      const host = hostOf(token);
      if (host !== null) return host;
    }
  }
  return null;
}

/** Origin host from a gitconfig `[remote "origin"]` section. */
export function parseBrewRemote(gitconfig: string): string | null {
  const lines = gitconfig.split('\n');
  let inOrigin = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(trimmed);
      continue;
    }
    if (!inOrigin) continue;
    const url = trimmed.match(/^url\s*=\s*(\S+)/i)?.[1];
    if (url === undefined) continue;
    // scp-like `git@host:path` carries no scheme: rewrite the first
    // colon past the host (a literal `host:` prefix would throw as a
    // non-numeric port).
    const scp = url.match(/^([^@\s]+)@([^:\s]+):(.*)$/);
    const normalized = scp !== null ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : url;
    const host = hostOf(normalized);
    if (host !== null) return host;
  }
  return null;
}

/**
 * Cache-clean command per environment (safe-clean set: archives and
 * stale metadata go, installed software stays). Absent cells are
 * honest unavailability, never guesses.
 */
const PURGE: Partial<Record<EnvId, string>> = {
  termux: 'pkg clean',
  debian: 'apt-get clean',
  wsl2: 'apt-get clean',
  arch: 'pacman -Sc --noconfirm',
  alpine: 'apk cache clean',
  fedora: 'dnf clean all',
  rhel: 'dnf clean all',
  macos: 'brew cleanup',
};

/** Cache-clean command for an environment. */
export function purgeCommand(env: EnvId): { ok: true; cmd: string } | { ok: false; reason: string } {
  const cmd = PURGE[env];
  if (cmd === undefined) return { ok: false, reason: `Cache purge unavailable for ${env}` };
  return { ok: true, cmd };
}
