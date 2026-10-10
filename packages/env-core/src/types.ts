/**
 * Shared types for environment detection.
 *
 * `env-core` is the only place allowed to branch on the host OS.
 * Feature code consumes {@link Environment} and never touches
 * `process.platform` or Termux `PREFIX` directly.
 */

/** Supported environment identities. */
export type EnvId =
  | 'termux'
  | 'debian'
  | 'arch'
  | 'alpine'
  | 'fedora'
  | 'rhel'
  | 'macos'
  | 'wsl2'
  | 'windows'
  | 'unknown';

/** Package managers per environment. */
export type PkgManId =
  | 'pkg'
  | 'apt'
  | 'pacman'
  | 'apk'
  | 'dnf'
  | 'yum'
  | 'brew'
  | 'winget'
  | 'none';

/** Service managers per environment. */
export type ServiceManId =
  | 'pm2'
  | 'systemd'
  | 'openrc'
  | 'launchd'
  | 'wsl-passthrough'
  | 'windows-sc'
  | 'none';

/** C library family (Linux only). Used for `node-pty` fallback messaging. */
export type Libc = 'glibc' | 'musl' | 'unknown';

/**
 * Detected host environment.
 */
export interface Environment {
  id: EnvId;
  /** Set when `id === 'wsl2'`: the inner distro identity. */
  inner?: EnvId;
  /** Human-readable label, e.g. `"Debian 12"`, `"Termux"`, `"Alpine 3.20"`. */
  prettyName: string;
  pkgman: PkgManId;
  service: ServiceManId;
  isWsl: boolean;
  /** Linux only: `musl` on Alpine, otherwise `glibc` when detectable. */
  libc?: Libc;
  /** Termux `$PREFIX` or `''` elsewhere. */
  prefix: string;
  /** Resolved shell or `'sh'` fallback (legacy Terwo semantics). */
  shell: string;
  /** Extra dirs to append to `PATH` for child processes. */
  pathExtra: string[];
}

/**
 * Injected signals for pure detection (no direct I/O).
 */
export interface Signals {
  platform: string;
  termuxVersion?: string;
  prefix: string;
  wslDistro?: string;
  /** Content of `/proc/version`, if readable. */
  procVersion?: string;
  /** Content of `/etc/os-release`, if readable. */
  osRelease?: string;
  /** PRETTY_NAME or derived label, if available. */
  osPretty?: string;
}
