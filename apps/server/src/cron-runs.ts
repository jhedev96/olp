import { readFileSync, writeFileSync } from 'node:fs';

/** One recorded execution (manual Run Now or future runners). */
export interface RunRecord {
  id: string;
  jobId: string;
  name: string;
  command: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  latencyMs: number;
  /** Tail of combined stdout+stderr (capped by the recorder). */
  output: string;
}

/** Bounded run-result store (newest-first reads). */
export interface RunStore {
  list(limit: number): RunRecord[];
  append(run: RunRecord): void;
}

const DEFAULT_CAP = 500;

function trim(store: RunRecord[], cap: number): RunRecord[] {
  return store.slice(0, Math.max(1, cap));
}

/**
 * File-backed store (`cron-runs.json`, mode `0600`). Corrupt or
 * missing files read as empty (never throw on list); append failures
 * are swallowed the same way (stats degrade, runs don't fail).
 */
export function fileRunStore(path: string, cap: number = DEFAULT_CAP): RunStore {
  const read = (): RunRecord[] => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(parsed) ? (parsed as RunRecord[]) : [];
    } catch {
      return [];
    }
  };
  const write = (runs: RunRecord[]): void => {
    try {
      writeFileSync(path, JSON.stringify(trim(runs, cap)), { mode: 0o600 });
    } catch {
      // stats degrade; the run itself already happened
    }
  };
  return {
    list: (limit) => read().slice(0, Math.max(1, Math.min(limit, cap))),
    append: (run) => write([run, ...read()]),
  };
}

/** Memory-backed store (tests + datadir-less setups; lost on restart). */
export function memoryRunStore(cap: number = DEFAULT_CAP): RunStore {
  let runs: RunRecord[] = [];
  return {
    list: (limit) => runs.slice(0, Math.max(1, Math.min(limit, cap))),
    append: (run) => {
      runs = trim([run, ...runs], cap);
    },
  };
}
