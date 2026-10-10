import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { apiJson } from '../lib/api.js';
import { fmtUptime } from '../lib/format.js';
import { CpuArea } from '../components/charts/CpuArea.js';
import type { CpuSample } from '../components/charts/CpuArea.js';
import { DiskBar } from '../components/charts/DiskBar.js';
import { MemoryDonut } from '../components/charts/MemoryDonut.js';
import { ComingSoon } from '../components/common/States.js';
import { Badge } from '../components/common/Badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';

/** Cadence options (mockup parity: 500ms / 1s / 5s, client-side only). */
const CADENCES = [500, 1000, 5000] as const;

/** Ring-buffer cap for the panel-observed load history. */
export const HISTORY_CAP = 60;

/** `/api/stats` subset consumed by the monitor. */
interface MonitorStats {
  uptime: number;
  cpu: { load1: number };
  mem: { total: number; used: number };
  disk: { total: number; used: number } | null;
  battery: { percentage: number; status: string } | { error: string };
}

/** Serialize collected samples for the Export JSON download. */
export function buildExport(cadenceMs: number, samples: CpuSample[]): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), cadenceMs, samples }, null, 2);
}

/**
 * Monitor (`/monitor`): hardware telemetry with honest sourcing. Load
 * wave, memory donut, disk bar, uptime, and battery percent are real
 * (polled `/api/stats`; the wave is a panel-observed ring buffer, not
 * per-core telemetry). Everything without a source ships as a tracked
 * dummy: cluster details + thermal + disk rates (CAND-014), network
 * interfaces/sockets (CAND-002), process table (CAND-001) and kill
 * (CAND-004). Refresh cadence, pause, and export are client-side real;
 * Kill Task scrolls to the process section.
 */
export function MonitorPage(): ReactElement {
  const [cadenceMs, setCadenceMs] = useState<number>(1000);
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [history, setHistory] = useState<CpuSample[]>([]);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const body = await apiJson<MonitorStats>('/api/stats');
        if (!alive) return;
        setStats(body);
        setHistory((prev) => {
          const next = [...prev.slice(-(HISTORY_CAP - 1)), { t: 'now', v: body.cpu.load1 }];
          return next.map((s, i) => (i === next.length - 1 ? s : { ...s, t: `-${((next.length - 1 - i) * cadenceMs) / 1000}s` }));
        });
      } catch {
        // keep the previous render on poll failure
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), cadenceMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [cadenceMs, paused]);

  const exportJson = (): void => {
    if (typeof URL.createObjectURL !== 'function') return;
    const blob = new Blob([buildExport(cadenceMs, history)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'monitor-export.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const scrollToProcesses = (): void => {
    try {
      document.getElementById('monitor-processes')?.scrollIntoView();
    } catch {
      // headless renderers without layout
    }
  };

  const battery = stats !== null && 'percentage' in stats.battery ? stats.battery : null;

  return (
    <main className="p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">Monitor</h1>
        <Badge tone="success">{paused ? 'Paused' : 'Live'}</Badge>
        <label className="flex items-center gap-1 text-xs text-neutral-400">
          Polling
          <select
            aria-label="Refresh cadence"
            className="h-8 rounded-md border border-neutral-700 bg-transparent px-2 text-xs"
            value={cadenceMs}
            onChange={(ev) => setCadenceMs(Number(ev.target.value))}
          >
            {CADENCES.map((ms) => (
              <option key={ms} value={ms}>
                {ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="outline" onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume stream' : 'Pause stream'}
        </Button>
        <Button size="sm" variant="outline" onClick={exportJson}>
          Export JSON
        </Button>
        <Button size="sm" variant="destructive" onClick={scrollToProcesses}>
          Kill task
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <h2 className="mb-2 font-bold">CPU load</h2>
          <CpuArea label="Panel-observed" samples={history} />
          <p className="mt-1 text-xs text-neutral-500">
            Panel-observed 1-minute load, sampled every {cadenceMs >= 1000 ? `${cadenceMs / 1000}s` : `${cadenceMs}ms`} — not per-core frequency (CAND-014).
          </p>
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Memory</h2>
          {stats === null ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : (
            <MemoryDonut label="Node" used={stats.mem.used} total={stats.mem.total} />
          )}
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Disk</h2>
          {stats?.disk ? (
            <DiskBar label="Data" used={stats.disk.used} total={stats.disk.total} />
          ) : (
            <p className="text-sm text-neutral-400">Loading…</p>
          )}
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Node</h2>
          <p className="text-sm text-neutral-300">Uptime {stats === null ? '—' : fmtUptime(stats.uptime)}</p>
          <p className="mt-1 text-sm text-neutral-300">
            Battery {battery === null ? '—' : `${battery.percentage}% · ${battery.status}`}
          </p>
        </Card>
      </div>

      <div className="mt-3 flex flex-col gap-3" id="monitor-processes">
        <ComingSoon feature="Cluster & thermal details" candidate="CAND-014" />
        <ComingSoon feature="Network I/O & sockets" candidate="CAND-002" />
        <ComingSoon feature="Active processes" candidate="CAND-001" />
        <ComingSoon feature="Process kill" candidate="CAND-004" />
      </div>
    </main>
  );
}
