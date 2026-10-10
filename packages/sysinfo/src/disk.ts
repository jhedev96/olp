import type { DiskInfo, SysDeps } from './types.js';

/** Single-quote a shell argument (same semantics as legacy `sq()`). */
function quoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse `df -k` output into {@link DiskInfo}.
 *
 * Reads the last line (`total/used/avail` in KiB) and converts to bytes,
 * preserving legacy Terwo semantics.
 *
 * @param output - Raw stdout of `df -k <root>`.
 * @returns Disk usage, or `null` when unparsable.
 */
export function parseDf(output: string): DiskInfo | null {
  const lines = output.trim().split('\n');
  const last = lines.length > 0 ? lines[lines.length - 1] : undefined;
  if (last === undefined || last.trim() === '') return null;
  const cols = last.trim().split(/\s+/);
  const totalKb = Number.parseInt(cols[1] ?? '', 10);
  const usedKb = Number.parseInt(cols[2] ?? '', 10);
  const freeKb = Number.parseInt(cols[3] ?? '', 10);
  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || !Number.isFinite(freeKb)) {
    return null;
  }
  const total = totalKb * 1024;
  const used = usedKb * 1024;
  const free = freeKb * 1024;
  return { total, used, free, percent: total > 0 ? Math.round((used / total) * 100) : 0 };
}

/**
 * Probe disk usage for `root` via `df -k`. Never throws:
 * probe failures resolve to `null`.
 */
export async function getDisk(exec: SysDeps['exec'], root: string): Promise<DiskInfo | null> {
  try {
    const out = await exec(`df -k ${quoteSingle(root)}`, 5000);
    return parseDf(out);
  } catch {
    return null;
  }
}
