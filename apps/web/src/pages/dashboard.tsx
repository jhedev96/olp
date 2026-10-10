import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { apiJson } from '../lib/api.js';
import { fmtDate, fmtSize, fmtUptime } from '../lib/format.js';
import { Card } from '../components/ui/card.js';

/** `/api/stats` payload shape (server contract). */
export interface SystemStats {
  hostname: string;
  uptime: number;
  time: number;
  cpu: { load1: number; load5: number; load15: number; cores: number };
  mem: { total: number; free: number; used: number; percent: number };
  disk: { total: number; used: number; free: number; percent: number } | null;
  battery: { percentage: number; status: string } | { error: string };
}

/** `/api/sites` row shape (subset used by the dashboard table). */
export interface DashSite {
  name: string;
  type: string;
  port: number;
  running: boolean;
}

/** Dashboard poll cadence (Terwo 5 s parity). */
export const STATS_POLL_MS = 5000;

function Bar({ percent }: { percent: number }): ReactElement {
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-800">
      <div className="h-full rounded-full bg-green-600 transition-all" style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

function StatCard({ label, value, sub, bar }: { label: string; value: string; sub: string; bar?: number }): ReactElement {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="text-[13px] text-neutral-400">{label}</div>
      <div className="mt-1.5 text-xl font-bold tracking-tight">{value}</div>
      {sub !== '' && <div className="mt-0.5 text-xs text-neutral-400">{sub}</div>}
      {bar !== undefined && <Bar percent={bar} />}
    </div>
  );
}

/**
 * Dashboard: live system cards + website table (Terwo dashboard parity).
 * Poll failures keep the previous render (never blank) and clean up
 * the timer on unmount.
 */
export function DashboardPage(): ReactElement {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [sites, setSites] = useState<DashSite[]>([]);

  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      try {
        const [next, siteList] = await Promise.all([
          apiJson<SystemStats>('/api/stats'),
          apiJson<{ sites: DashSite[] }>('/api/sites'),
        ]);
        if (alive) {
          setStats(next);
          setSites(siteList.sites);
        }
      } catch {
        // keep the previous render on poll failure (Terwo parity)
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), STATS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const battery =
    stats !== null && 'percentage' in stats.battery
      ? { value: `${stats.battery.percentage}%`, sub: stats.battery.status }
      : { value: '—', sub: stats !== null && 'error' in stats.battery ? stats.battery.error : '' };

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-bold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="CPU" value={stats !== null ? stats.cpu.load1.toFixed(2) : '—'} sub={stats !== null ? `${stats.cpu.cores} core` : '—'} />
        <StatCard
          label="RAM"
          value={stats !== null ? `${stats.mem.percent}%` : '—'}
          sub={stats !== null ? `${fmtSize(stats.mem.used)} / ${fmtSize(stats.mem.total)}` : '—'}
          bar={stats?.mem.percent}
        />
        <StatCard
          label="Disk"
          value={stats?.disk ? `${stats.disk.percent}%` : '—'}
          sub={stats?.disk ? `${fmtSize(stats.disk.used)} / ${fmtSize(stats.disk.total)}` : ''}
          bar={stats?.disk?.percent}
        />
        <StatCard label="Battery" value={battery.value} sub={battery.sub} />
        <StatCard label="Uptime" value={stats !== null ? fmtUptime(stats.uptime) : '—'} sub={stats !== null ? fmtDate(stats.time) : '—'} />
      </div>
      <Card className="mt-4">
        <table className="w-full text-sm">
          <tbody>
            {sites.length === 0 ? (
              <tr>
                <td className="text-neutral-400">No websites yet</td>
              </tr>
            ) : (
              sites.map((site) => (
                <tr key={`${site.name}:${site.port}`}>
                  <td>{site.name}</td>
                  <td className="text-neutral-400">{site.type}</td>
                  <td className="text-neutral-400">{site.port}</td>
                  <td>
                    <span className={site.running ? 'text-green-400' : 'text-neutral-500'}>
                      {site.running ? 'Running' : 'Stopped'}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </main>
  );
}
