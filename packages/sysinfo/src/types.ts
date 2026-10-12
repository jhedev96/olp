/**
 * Shared types for system information providers.
 *
 * All host interaction is injected via {@link SysDeps} so providers
 * stay pure and unit-testable. Callers pass an `env-core`
 * {@link Environment} to select per-OS behavior.
 */

export interface CpuInfo {
  load1: number;
  load5: number;
  load15: number;
  cores: number;
}

export interface MemInfo {
  total: number;
  free: number;
  used: number;
  percent: number;
}

export interface DiskInfo {
  total: number;
  used: number;
  free: number;
  percent: number;
}

/** Battery reading, or `{error}` when unavailable (dashboard handles both). */
export type BatteryInfo = { percentage: number; status: string } | { error: string };

export interface SystemInfo {
  hostname: string;
  /** Uptime in whole seconds. */
  uptime: number;
  /** Unix timestamp in milliseconds. */
  time: number;
  cpu: CpuInfo;
  mem: MemInfo;
  /** `null` when the disk probe fails. */
  disk: DiskInfo | null;
  battery: BatteryInfo;
}

/** Shell runner: resolves stdout, rejects `Error` on failure/timeout. */
export type ExecFn = (cmd: string, timeoutMs: number) => Promise<string>;

/**
 * Injectable host dependencies. Production wires `node:os`,
 * `node:fs`, and `child_process`; tests inject fakes.
 */
export interface SysDeps {
  cpus: () => Array<{ times?: unknown }>;
  loadavg: () => number[];
  totalmem: () => number;
  freemem: () => number;
  hostname: () => string;
  uptime: () => number;
  /** CPU architecture string (production: `os.arch()`). */
  arch: () => string;
  exec: ExecFn;
  readDir: (path: string) => string[];
  readFile: (path: string) => string | null;
  now: () => number;
}
