import type { Environment } from '@olp/env-core';
import type { BatteryInfo, SysDeps } from './types.js';

/** Single-quote a shell argument (same semantics as legacy `sq()`). */
function quoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Resolve the battery command, preferring the absolute Termux path. */
function batteryCommand(prefix: string): string {
  if (prefix !== '') return quoteSingle(`${prefix}/bin/termux-battery-status`);
  return 'termux-battery-status';
}

/**
 * Read the battery level for the detected environment.
 *
 * Only Termux is probed in v1; every other environment returns
 * `{error:'unavailable'}` until its parser lands (see SPEC).
 * Never throws: all probe failures map to `{error}`.
 */
export async function getBattery(
  env: Environment,
  exec: SysDeps['exec'],
): Promise<BatteryInfo> {
  if (env.id !== 'termux') return { error: 'unavailable' };
  let raw: string;
  try {
    raw = await exec(batteryCommand(env.prefix), 8000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|ENOENT|command not found/i.test(msg)) return { error: 'pkg install termux-api' };
    if (/timed out|ETIMEDOUT/i.test(msg)) return { error: 'Termux:API app required' };
    return { error: msg.slice(0, 120) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as { percentage?: unknown; status?: unknown };
      if (typeof obj.percentage === 'number') {
        return {
          percentage: obj.percentage,
          status: typeof obj.status === 'string' ? obj.status : '',
        };
      }
    }
    return { error: 'Termux:API no response' };
  } catch {
    return { error: 'Termux:API no response' };
  }
}
