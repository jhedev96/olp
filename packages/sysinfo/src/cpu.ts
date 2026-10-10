import type { SysDeps } from './types.js';

/**
 * Count CPU cores, preserving legacy Terwo fallback semantics:
 * `os.cpus()` → `/sys/devices/system/cpu` entries → `/proc/cpuinfo`
 * `processor:` lines → `0`.
 *
 * @param deps - Injectable host readers.
 * @returns Core count, or `0` when undetectable.
 */
export function cpuCores(deps: Pick<SysDeps, 'cpus' | 'readDir' | 'readFile'>): number {
  try {
    const count = deps.cpus().length;
    if (count > 0) return count;
  } catch {
    // fall through to sysfs
  }
  try {
    const entries = deps.readDir('/sys/devices/system/cpu').filter((f) => /^cpu[0-9]+$/.test(f));
    if (entries.length > 0) return entries.length;
  } catch {
    // fall through to cpuinfo
  }
  try {
    const raw = deps.readFile('/proc/cpuinfo');
    if (raw !== null) {
      const count = (raw.match(/^processor\s*:/gm) ?? []).length;
      if (count > 0) return count;
    }
  } catch {
    // fall through to zero
  }
  return 0;
}
