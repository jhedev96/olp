import type { SysDeps } from './types.js';

/** One supervised daemon (binary names are stable; unit names are not). */
export interface DaemonDef {
  id: 'mariadb' | 'postgres' | 'redis' | 'cronie';
  comms: string[];
}

/** Daemons surfaced on the dashboard (presence = running). */
export const DAEMONS: DaemonDef[] = [
  { id: 'mariadb', comms: ['mysqld', 'mariadbd'] },
  { id: 'postgres', comms: ['postgres'] },
  { id: 'redis', comms: ['redis-server'] },
  { id: 'cronie', comms: ['crond', 'cron'] },
];

const MAX_PIDS = 512;

/**
 * Scan process presence per daemon. Reads `/proc/<pid>/comm` (falling
 * back to `status` Name) and exact-matches against each daemon's binary
 * list. Raced exits are skipped; a failed directory read marks every
 * daemon stopped. Never throws — absence of evidence is `false`.
 *
 * @param deps - Injectable `/proc` readers.
 * @returns Map of daemon id → running.
 */
export function scanDaemons(deps: Pick<SysDeps, 'readDir' | 'readFile'>): Record<string, boolean> {
  const found: Record<string, boolean> = {};
  for (const def of DAEMONS) found[def.id] = false;
  let pids: string[];
  try {
    pids = deps.readDir('/proc').filter((d) => /^\d+$/.test(d)).slice(0, MAX_PIDS);
  } catch {
    return found;
  }
  for (const pid of pids) {
    let name: string | null = null;
    try {
      const comm = deps.readFile(`/proc/${pid}/comm`);
      if (comm !== null && comm.trim() !== '') {
        name = comm.trim();
      } else {
        const status = deps.readFile(`/proc/${pid}/status`);
        const match = status?.match(/^Name:\s*(.+)$/m);
        name = match?.[1]?.trim() ?? null;
      }
    } catch {
      continue; // raced exit — skip, never fail the batch
    }
    if (name === null) continue;
    for (const def of DAEMONS) {
      if (def.comms.includes(name)) found[def.id] = true;
    }
  }
  return found;
}
