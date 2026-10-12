/** Allowed signals (raw numbers are never client-chosen). */
export type KillSignal = 'TERM' | 'KILL';

/** Injected kill dependencies (production wires `process.*` + `/proc`). */
export interface KillDeps {
  /** Panel's own pid (production: `process.pid`). */
  selfPid: () => number;
  /** Panel's euid, null when unavailable (production: `process.getuid?.()`). */
  selfUid: () => number | null;
  /** Real uid of a target pid, null when unreadable. */
  targetUid: (pid: number) => number | null;
  /** Signal sender (production: `process.kill`). Throws on failure. */
  sendSignal: (pid: number, signal: KillSignal) => void;
}

/** Kill decision (route maps non-ok reasons to status codes). */
export type KillVerdict =
  | { ok: true; pid: number; signal: KillSignal }
  | {
    ok: false;
    reason: 'bad-pid' | 'denied-self' | 'denied-init' | 'denied-owner' | 'gone' | 'denied-os' | 'failed';
    detail?: string;
  };

function denied(
  reason: Exclude<KillVerdict, { ok: true }>['reason'],
): KillVerdict {
  return { ok: false, reason };
}

/**
 * Decide (and on allow, perform) a process kill under deny-by-default
 * authz: integer pid ≥ 2, never init, never self, and non-root callers
 * may only signal their own uid. OS errors map by errno code
 * (`ESRCH` → gone, `EPERM`/`EACCES` → denied-os, rest → failed).
 * Pure except for the injected sender.
 *
 * @param deps - Injectable identity + sender.
 * @param pid - Target process id.
 * @param signal - `TERM` (default upstream) or `KILL`.
 */
export function decideKill(deps: KillDeps, pid: number, signal: KillSignal): KillVerdict {
  if (pid === 1) return denied('denied-init');
  if (!Number.isInteger(pid) || pid < 2) return denied('bad-pid');
  if (pid === deps.selfPid()) return denied('denied-self');
  const selfUid = deps.selfUid();
  if (selfUid !== 0) {
    const owner = deps.targetUid(pid);
    if (owner === null || owner !== selfUid) return denied('denied-owner');
  }
  try {
    deps.sendSignal(pid, signal);
    return { ok: true, pid, signal };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ESRCH') return denied('gone');
    if (code === 'EPERM' || code === 'EACCES') return denied('denied-os');
    const detail = err instanceof Error ? err.message.slice(0, 200) : undefined;
    return detail === undefined ? { ok: false, reason: 'failed' } : { ok: false, reason: 'failed', detail };
  }
}
