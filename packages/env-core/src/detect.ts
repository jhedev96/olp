import * as fs from 'node:fs';
import type { Environment, EnvId, Libc, PkgManId, ServiceManId, Signals } from './types.js';

/**
 * Options for {@link detect}. All fields are injectable so tests
 * can run detection without touching the real host.
 */
export interface DetectOptions {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string | null;
  existsSync?: (path: string) => boolean;
}

const OS_RELEASE_PATH = '/etc/os-release';
const PROC_VERSION_PATH = '/proc/version';

/**
 * Parse the `ID` and `ID_LIKE` fields from `os-release` content.
 *
 * @param content - Raw `/etc/os-release` text.
 * @returns Lower-cased `id` and `like` tokens (empty string when absent).
 */
export function parseOsRelease(content: string): { id: string; like: string } {
  let id = '';
  let like = '';
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('ID=')) id = trimmed.slice(3).replace(/["']/g, '').toLowerCase();
    else if (trimmed.startsWith('ID_LIKE=')) like = trimmed.slice(8).replace(/["']/g, '').toLowerCase();
  }
  return { id, like };
}

/**
 * Map an `os-release` id/like pair to an {@link EnvId}.
 *
 * @param id - Lower-cased `ID` value.
 * @param like - Lower-cased `ID_LIKE` value.
 * @returns Linux distro identity or `'unknown'`.
 */
export function distroFromOsRelease(id: string, like: string): EnvId {
  const tokens = `${id} ${like}`;
  if (/(^|\s)(debian|ubuntu|linuxmint|pop|raspbian)($|\s)/.test(tokens)) return 'debian';
  if (/(^|\s)(arch|manjaro|endeavouros)($|\s)/.test(tokens)) return 'arch';
  if (tokens.includes('alpine')) return 'alpine';
  if (tokens.includes('fedora')) return 'fedora';
  if (/(^|\s)(rhel|centos|rocky|almalinux|ol)($|\s)/.test(tokens)) return 'rhel';
  return 'unknown';
}

/**
 * Resolve package manager and service manager for a Linux distro id.
 */
function managersFor(id: EnvId): { pkgman: PkgManId; service: ServiceManId } {
  switch (id) {
    case 'debian':
      return { pkgman: 'apt', service: 'systemd' };
    case 'arch':
      return { pkgman: 'pacman', service: 'systemd' };
    case 'alpine':
      return { pkgman: 'apk', service: 'openrc' };
    case 'fedora':
      return { pkgman: 'dnf', service: 'systemd' };
    case 'rhel':
      return { pkgman: 'dnf', service: 'systemd' };
    default:
      return { pkgman: 'none', service: 'none' };
  }
}

/**
 * Resolve the shell, preserving legacy Terwo fallback semantics:
 * first existing of `/bin/bash` and `$PREFIX/bin/bash`, else `'sh'`.
 */
function resolveShell(prefix: string, existsSync: (p: string) => boolean): string {
  const candidates = ['/bin/bash'];
  if (prefix !== '') candidates.push(`${prefix}/bin/bash`);
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // ignore probe errors, try next candidate
    }
  }
  return 'sh';
}

/**
 * Pure detection from injected signals. Never touches I/O.
 *
 * Precedence: termux > wsl2 wrapper > macos > windows > linux distros > unknown.
 *
 * @param signals - Injected host signals.
 * @param existsSync - File-existence probe for shell resolution.
 * @returns Detected environment (never throws).
 */
export function detectFromSignals(
  signals: Signals,
  existsSync: (p: string) => boolean = () => false,
): Environment {
  const prefix = signals.prefix ?? '';

  if (signals.termuxVersion !== undefined || prefix.includes('com.termux')) {
    return {
      id: 'termux',
      prettyName: 'Termux',
      pkgman: 'pkg',
      service: 'pm2',
      isWsl: false,
      prefix,
      shell: resolveShell(prefix, existsSync),
      pathExtra: [prefix !== '' ? `${prefix}/bin` : '', '/system/bin', '/system/xbin'].filter(
        (d): d is string => d !== '',
      ),
    };
  }

  const procHitsMicrosoft = (signals.procVersion ?? '').toLowerCase().includes('microsoft');
  if (signals.wslDistro !== undefined || procHitsMicrosoft) {
    let inner: EnvId = 'unknown';
    if (signals.osRelease !== undefined) {
      const parsed = parseOsRelease(signals.osRelease);
      inner = distroFromOsRelease(parsed.id, parsed.like);
    }
    const innerManagers = managersFor(inner);
    return {
      id: 'wsl2',
      inner,
      prettyName: `WSL2${signals.wslDistro !== undefined ? ` (${signals.wslDistro})` : ''}`,
      pkgman: innerManagers.pkgman,
      service: 'wsl-passthrough',
      isWsl: true,
      libc: 'glibc',
      prefix: '',
      shell: resolveShell('', existsSync),
      pathExtra: [],
    };
  }

  if (signals.platform === 'darwin') {
    return {
      id: 'macos',
      prettyName: signals.osPretty ?? 'macOS',
      pkgman: 'brew',
      service: 'launchd',
      isWsl: false,
      prefix: '',
      shell: resolveShell('', existsSync),
      pathExtra: [],
    };
  }

  if (signals.platform === 'win32') {
    return {
      id: 'windows',
      prettyName: 'Windows',
      pkgman: 'winget',
      service: 'windows-sc',
      isWsl: false,
      prefix: '',
      shell: resolveShell('', existsSync),
      pathExtra: [],
    };
  }

  if (signals.osRelease !== undefined) {
    const { id, like } = parseOsRelease(signals.osRelease);
    const distro = distroFromOsRelease(id, like);
    const managers = managersFor(distro);
    const libc: Libc = distro === 'alpine' ? 'musl' : distro === 'unknown' ? 'unknown' : 'glibc';
    return {
      id: distro,
      prettyName: signals.osPretty ?? distro,
      pkgman: managers.pkgman,
      service: managers.service,
      isWsl: false,
      libc,
      prefix: '',
      shell: resolveShell('', existsSync),
      pathExtra: [],
    };
  }

  return {
    id: 'unknown',
    prettyName: 'Unknown',
    pkgman: 'none',
    service: 'none',
    isWsl: false,
    prefix: '',
    shell: resolveShell('', existsSync),
    pathExtra: [],
  };
}

/**
 * Detect the current host environment (I/O-injectable for tests).
 *
 * Never throws on missing files: unreadable `/etc/os-release`
 * or `/proc/version` degrades to `'unknown'` instead.
 */
export function detect(opts: DetectOptions = {}): Environment {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const readFile =
    opts.readFile ??
    ((p: string): string | null => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    });
  const existsSync = opts.existsSync ?? fs.existsSync;

  const osReleaseRaw = readFile(OS_RELEASE_PATH);
  let osPretty: string | undefined;
  if (osReleaseRaw !== null) {
    for (const line of osReleaseRaw.split('\n')) {
      const t = line.trim();
      if (t.startsWith('PRETTY_NAME=')) {
        osPretty = t.slice('PRETTY_NAME='.length).replace(/["']/g, '');
        break;
      }
    }
  }

  return detectFromSignals(
    {
      platform,
      termuxVersion: env['TERMUX_VERSION'],
      prefix: env['PREFIX'] ?? '',
      wslDistro: env['WSL_DISTRO_NAME'],
      procVersion: readFile(PROC_VERSION_PATH) ?? undefined,
      osRelease: osReleaseRaw ?? undefined,
      osPretty,
    },
    existsSync,
  );
}
