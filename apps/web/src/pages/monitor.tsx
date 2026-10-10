import type { ReactElement } from 'react';

/**
 * Monitor placeholder (P1 shell wiring only — the telemetry panels
 * land in P3 as tracked dummies: CAND-001 processes, CAND-002 network,
 * CAND-004 kill, CAND-014 extended telemetry).
 */
export function MonitorPage(): ReactElement {
  return (
    <main className="p-4">
      <h1 className="mb-2 text-xl font-bold">Monitor</h1>
      <p className="text-sm text-neutral-400">
        Hardware telemetry lands here (CAND-001, CAND-002, CAND-004, CAND-014).
      </p>
    </main>
  );
}
