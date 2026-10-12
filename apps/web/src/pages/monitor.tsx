import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { apiJson, ApiError } from '../lib/api.js';
import { fmtSize, fmtUptime } from '../lib/format.js';
import { CpuArea } from '../components/charts/CpuArea.js';
import type { CpuSample } from '../components/charts/CpuArea.js';
import { DiskBar } from '../components/charts/DiskBar.js';
import { MemoryDonut } from '../components/charts/MemoryDonut.js';
import { NetSpark } from '../components/charts/NetSpark.js';
import { ConfirmDialog } from '../components/common/Dialog.js';
import { DataTable } from '../components/common/DataTable.js';
import { Badge } from '../components/common/Badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';

/** Cadence options (mockup parity: 500ms / 1s / 5s, client-side only). */
const CADENCES = [500, 1000, 5000] as const;

/** Ring-buffer cap for panel-observed histories. */
export const HISTORY_CAP = 60;

/** `/api/monitor/summary` subset consumed by the page. */
export interface SummaryCore {
  index: number;
  percent: number | null;
  freqMhz: number | null;
}
export interface MonitorSummary {
  hostname: string;
  uptime: number;
  arch: string;
  kernel: string | null;
  cpu: { load1: number; cores: number; perCore: SummaryCore[]; model: string | null; tempC: number | null };
  mem: { total: number; used: number; swapTotal: number | null; swapFree: number | null };
  disk: { total: number; used: number; io: { readRateBps: number; writeRateBps: number } | null } | null;
  net: {
    interfaces: Array<{ name: string; rxBytes: number; txBytes: number; rxRateBps: number | null; txRateBps: number | null }>;
    listeningPorts: number[];
  };
  battery: { percentage: number; status: string } | { error: string };
}

/** `/api/monitor/processes` subset consumed by the page. */
export interface MonitorProc {
  pid: number;
  command: string;
  cpuPercent: number | null;
  memBytes: number;
  uptimeSec: number | null;
}
export interface MonitorPm {
  name: string;
  pid: number | null;
  status: string;
  cpuPercent: number | null;
  memBytes: number | null;
}

/** Serialize collected samples for the Export JSON download. */
export function buildExport(cadenceMs: number, samples: CpuSample[]): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), cadenceMs, samples }, null, 2);
}

/**
 * Monitor (`/monitor`): live telemetry from the wave-1 endpoints plus
 * wave-2 per-row process kill (SIGTERM behind ConfirmDialog, deny-by-
 * default server authz). Load wave + network spark are panel-observed
 * ring buffers; per-core bars, model/kernel/arch, temp, swap, disk
 * rates, interfaces, sockets, process table, and PM2 rows are
 * server-measured. Refresh cadence, pause, and export are client-side
 * real. The header Kill Task button scrolls to the table.
 */
export function MonitorPage(): ReactElement {
  const [cadenceMs, setCadenceMs] = useState<number>(1000);
  const [paused, setPaused] = useState(false);
  const [summary, setSummary] = useState<MonitorSummary | null>(null);
  const [procs, setProcs] = useState<MonitorProc[]>([]);
  const [pm2, setPm2] = useState<MonitorPm[] | null>(null);
  const [history, setHistory] = useState<CpuSample[]>([]);
  const [netHist, setNetHist] = useState<Array<{ i: number; down: number; up: number }>>([]);
  const [pendingKill, setPendingKill] = useState<MonitorProc | null>(null);
  const [killError, setKillError] = useState('');

  useEffect(() => {
    if (paused) return;
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const [next, procBody] = await Promise.all([
          apiJson<MonitorSummary>('/api/monitor/summary'),
          apiJson<{ processes: MonitorProc[]; pm2: MonitorPm[] | null }>('/api/monitor/processes?limit=25'),
        ]);
        if (!alive) return;
        setSummary(next);
        setProcs(procBody.processes);
        setPm2(procBody.pm2);
        setHistory((prev) => {
          const nextHist = [...prev.slice(-(HISTORY_CAP - 1)), { t: 'now', v: next.cpu.load1 }];
          return nextHist.map((s, i) =>
            i === nextHist.length - 1 ? s : { ...s, t: `-${((nextHist.length - 1 - i) * cadenceMs) / 1000}s` },
          );
        });
        const down = next.net.interfaces.reduce((sum, iface) => sum + (iface.rxRateBps ?? 0), 0);
        const up = next.net.interfaces.reduce((sum, iface) => sum + (iface.txRateBps ?? 0), 0);
        setNetHist((prev) => [...prev.slice(-(HISTORY_CAP - 1)), { i: prev.length, down, up }]);
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

  const refreshProcs = async (): Promise<void> => {
    try {
      const body = await apiJson<{ processes: MonitorProc[]; pm2: MonitorPm[] | null }>('/api/monitor/processes?limit=25');
      setProcs(body.processes);
      setPm2(body.pm2);
    } catch {
      // keep the previous render on poll failure
    }
  };

  const confirmKill = async (): Promise<void> => {
    if (pendingKill === null) return;
    const target = pendingKill;
    setPendingKill(null);
    setKillError('');
    try {
      await apiJson(`/api/monitor/processes/${target.pid}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await refreshProcs();
    } catch (err) {
      setKillError(err instanceof ApiError ? err.message : 'Kill failed');
    }
  };

  const battery = summary !== null && 'percentage' in summary.battery ? summary.battery : null;
  const swapUsed =
    summary !== null && summary.mem.swapTotal !== null && summary.mem.swapFree !== null
      ? summary.mem.swapTotal - summary.mem.swapFree
      : null;

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
            Panel-observed 1-minute load, sampled every {cadenceMs >= 1000 ? `${cadenceMs / 1000}s` : `${cadenceMs}ms`}.
          </p>
          {summary !== null && (
            <div className="mt-2 flex flex-col gap-1">
              {summary.cpu.perCore.slice(0, 8).map((core) => (
                <div key={core.index} className="flex items-center gap-2 text-xs text-neutral-400">
                  <span className="w-12 font-mono">cpu{core.index}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${core.percent ?? 0}%` }} />
                  </div>
                  <span className="w-16 text-right font-mono">
                    {core.percent === null ? '—' : `${core.percent}%`}
                    {core.freqMhz === null ? '' : ` ${core.freqMhz}MHz`}
                  </span>
                </div>
              ))}
              {summary.cpu.perCore.length > 8 && (
                <p className="text-xs text-neutral-500">+{summary.cpu.perCore.length - 8} more cores</p>
              )}
              <p className="mt-1 text-xs text-neutral-500">
                {[summary.cpu.model, summary.arch, summary.kernel].filter((p) => p !== null && p !== '').join(' · ')}
                {summary.cpu.tempC !== null && ` · ${summary.cpu.tempC}°C`}
              </p>
            </div>
          )}
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Memory</h2>
          {summary === null ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : (
            <>
              <MemoryDonut label="Node" used={summary.mem.used} total={summary.mem.total} />
              <p className="mt-1 text-xs text-neutral-500">
                Swap {swapUsed === null || summary.mem.swapTotal === null ? '—' : `${fmtSize(swapUsed)} / ${fmtSize(summary.mem.swapTotal)}`}
              </p>
            </>
          )}
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Disk</h2>
          {summary?.disk ? (
            <>
              <DiskBar label="Data" used={summary.disk.used} total={summary.disk.total} />
              <p className="mt-1 text-xs text-neutral-500">
                {summary.disk.io === null
                  ? 'I/O rates on next poll'
                  : `Read ${fmtSize(summary.disk.io.readRateBps)}/s · Write ${fmtSize(summary.disk.io.writeRateBps)}/s`}
              </p>
            </>
          ) : (
            <p className="text-sm text-neutral-400">Loading…</p>
          )}
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Network</h2>
          {summary === null ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : (
            <>
              <NetSpark label="Throughput" unitLabel="B/s" down={netHist.map((s) => s.down)} up={netHist.map((s) => s.up)} />
              <ul className="mt-2 flex flex-col gap-1 text-xs text-neutral-400">
                {summary.net.interfaces.map((iface) => (
                  <li key={iface.name} className="flex justify-between gap-2 font-mono">
                    <span>{iface.name}</span>
                    <span>↓ {fmtSize(iface.rxBytes)} ↑ {fmtSize(iface.txBytes)}</span>
                  </li>
                ))}
              </ul>
              {summary.net.listeningPorts.length > 0 && (
                <p className="mt-1 font-mono text-xs text-neutral-500">
                  LISTEN :{summary.net.listeningPorts.join(' :')}
                </p>
              )}
            </>
          )}
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Node</h2>
          <p className="text-sm text-neutral-300">Uptime {summary === null ? '—' : fmtUptime(summary.uptime)}</p>
          <p className="mt-1 text-sm text-neutral-300">
            Battery {battery === null ? '—' : `${battery.percentage}% · ${battery.status}`}
          </p>
        </Card>
      </div>

      <div className="mt-3 flex flex-col gap-3" id="monitor-processes">
        {killError !== '' && (
          <p role="alert" className="text-sm text-red-400">
            {killError}
          </p>
        )}
        <Card className="p-0">
          <div className="overflow-x-auto">
            <DataTable<MonitorProc>
              label="Active processes"
              columns={[
                { key: 'pid', header: 'PID', cell: (p) => <span className="font-mono">{p.pid}</span> },
                {
                  key: 'command',
                  header: 'Process Command',
                  cell: (p) => <span className="font-mono text-xs">{p.command}</span>,
                },
                { key: 'cpu', header: 'CPU %', cell: (p) => (p.cpuPercent === null ? '—' : `${p.cpuPercent}%`) },
                { key: 'mem', header: 'MEM', cell: (p) => fmtSize(p.memBytes) },
                { key: 'uptime', header: 'Uptime', cell: (p) => (p.uptimeSec === null ? '—' : fmtUptime(p.uptimeSec)) },
                {
                  key: 'kill',
                  header: 'Actions',
                  cell: (p) => (
                    <Button size="sm" variant="destructive" onClick={() => setPendingKill(p)}>
                      Kill
                    </Button>
                  ),
                },
              ]}
              rows={procs}
              rowKey={(p) => String(p.pid)}
              emptyText="No processes yet"
            />
          </div>
        </Card>
        {pm2 !== null && pm2.length > 0 && (
          <Card>
            <h2 className="mb-2 font-bold">PM2 ({pm2.length})</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {pm2.map((row) => (
                <li key={row.name} className="flex items-center gap-2">
                  <span className="mr-auto font-mono text-xs">{row.name}</span>
                  <span className="text-xs text-neutral-400">{row.status}</span>
                  {row.memBytes !== null && <span className="text-xs text-neutral-400">{fmtSize(row.memBytes)}</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <ConfirmDialog
        open={pendingKill !== null}
        title="Kill process"
        message={
          pendingKill === null
            ? ''
            : `Kill PID ${pendingKill.pid} (${pendingKill.command})? The process gets SIGTERM and may lose unsaved work.`
        }
        confirmLabel="Kill"
        destructive={true}
        onConfirm={() => void confirmKill()}
        onCancel={() => setPendingKill(null)}
      />
    </main>
  );
}
