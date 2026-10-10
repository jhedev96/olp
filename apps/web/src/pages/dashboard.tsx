import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { apiJson } from '../lib/api.js';
import { fmtDate, fmtSize, fmtUptime } from '../lib/format.js';
import { navigateTo } from '../lib/router.js';
import { Badge } from '../components/common/Badge.js';
import { ComingSoon } from '../components/common/States.js';
import { Button } from '../components/ui/button.js';
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

/** `/api/install` item shape (subset used by the store preview). */
export interface DashStoreItem {
  id: string;
  name: string;
  installed: boolean;
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
 * Dashboard (mockup dashboard parity): live system cards, site table
 * with open-links, store preview, and tracked dummies. Poll failures
 * keep the previous render (never blank) and clean up on unmount.
 * Honestly omitted (no source, backend frozen): CPU temp/frequency,
 * ZRAM/swap, disk FS type, battery thermal/wakelock, PM2 badge,
 * per-site memory (all CAND-014/015); restart-panel ships disabled
 * (CAND-015); services (CAND-005) and log tail (CAND-013) are
 * Coming-Soon sections.
 */
export function DashboardPage(): ReactElement {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [sites, setSites] = useState<DashSite[]>([]);
  const [store, setStore] = useState<DashStoreItem[] | null>(null);

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

  useEffect(() => {
    let alive = true;
    void apiJson<{ items: DashStoreItem[] }>('/api/install')
      .then((body) => {
        if (alive && Array.isArray(body.items)) setStore(body.items);
      })
      .catch(() => {
        // store preview stays empty rather than blocking the page
      });
    return () => {
      alive = false;
    };
  }, []);

  const battery =
    stats !== null && 'percentage' in stats.battery
      ? { value: `${stats.battery.percentage}%`, sub: stats.battery.status }
      : { value: '—', sub: stats !== null && 'error' in stats.battery ? stats.battery.error : '' };

  const siteHost = typeof window === 'undefined' ? '' : window.location.hostname;

  return (
    <main className="p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">Dashboard</h1>
        <Button size="sm" variant="outline" onClick={() => navigateTo('terminal')}>
          Web terminal
        </Button>
        <Button size="sm" variant="outline" onClick={() => navigateTo('website')}>
          New website
        </Button>
        <Button size="sm" variant="outline" disabled={true} title="Coming soon (CAND-015)">
          Restart panel
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="CPU" value={stats !== null ? stats.cpu.load1.toFixed(2) : '—'} sub={stats !== null ? `${stats.cpu.cores} core · ${stats.cpu.load5.toFixed(2)} / ${stats.cpu.load15.toFixed(2)}` : '—'} />
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
        <h2 className="mb-2 font-bold">Websites</h2>
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
                  <td>
                    {site.running && siteHost !== '' && (
                      <a className="text-xs text-green-400" href={`http://${siteHost}:${site.port}`} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Card>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="mr-auto font-bold">Store preview</h2>
            {store !== null && <Badge tone="info">{store.length} available</Badge>}
            <Button size="sm" variant="ghost" onClick={() => navigateTo('store')}>
              Open store
            </Button>
          </div>
          {store === null ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {store.slice(0, 6).map((item) => (
                <li key={item.id} className="flex items-center gap-2">
                  <span className="mr-auto">{item.name}</span>
                  {item.installed && <Badge tone="success">Installed</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="flex flex-col gap-3">
          <ComingSoon feature="Services & Daemons" candidate="CAND-005" />
          <ComingSoon feature="Panel log tail" candidate="CAND-013" />
        </div>
      </div>
    </main>
  );
}
