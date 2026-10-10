import type { Environment } from '@olp/env-core';
import { getBattery } from './battery.js';
import { cpuCores } from './cpu.js';
import { getDisk } from './disk.js';
import type { SystemInfo, SysDeps } from './types.js';

/** Round to 2 decimals (matches legacy `+n.toFixed(2)` display). */
function round2(n: number): number {
  return Number(n.toFixed(2));
}

/**
 * Compose the full dashboard payload (Terwo-compatible shape).
 *
 * Provider failures degrade gracefully: disk probe failure → `null`,
 * battery unavailable → `{error}`. Only programmer errors (e.g. bad
 * `root` type) throw.
 *
 * @param env - Detection result from `env-core`.
 * @param deps - Injectable host dependencies.
 * @param root - Directory the disk probe measures (file-manager root).
 */
export async function getSystemInfo(
  env: Environment,
  deps: SysDeps,
  root: string,
): Promise<SystemInfo> {
  const loads = deps.loadavg();
  const total = deps.totalmem();
  const free = deps.freemem();
  const used = total - free;
  const [disk, battery] = await Promise.all([getDisk(deps.exec, root), getBattery(env, deps.exec)]);
  return {
    hostname: deps.hostname(),
    uptime: Math.floor(deps.uptime()),
    time: deps.now(),
    cpu: {
      load1: round2(loads[0] ?? 0),
      load5: round2(loads[1] ?? 0),
      load15: round2(loads[2] ?? 0),
      cores: cpuCores(deps),
    },
    mem: {
      total,
      free,
      used,
      percent: total > 0 ? Math.round((used / total) * 100) : 0,
    },
    disk,
    battery,
  };
}

export { getBattery } from './battery.js';
export { cpuCores } from './cpu.js';
export { getDisk, parseDf } from './disk.js';
export type { BatteryInfo, CpuInfo, DiskInfo, MemInfo, SysDeps, SystemInfo } from './types.js';
