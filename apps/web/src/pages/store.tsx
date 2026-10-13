import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtSize } from '../lib/format.js';
import { navigateTo } from '../lib/router.js';
import { ConfirmDialog } from '../components/common/Dialog.js';
import { EmptyState } from '../components/common/States.js';
import { Badge } from '../components/common/Badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** `/api/install` item shape (server contract). */
export interface StoreItem {
  id: string;
  name: string;
  desc: string;
  conf: string | null;
  installed: boolean;
  installing: boolean;
}

/** `/api/install/mirror` shape (nulls are honest unknowns). */
export interface MirrorInfo {
  manager: string | null;
  mirror: string | null;
  latencyMs: number | null;
}

/** Manager-op run slots (log modal reuse). */
export type OpKind = 'update' | 'upgrade' | 'purge';

const OP_LABEL: Record<OpKind, string> = { update: 'Repo update', upgrade: 'Batch upgrade', purge: 'Cache purge' };
const OP_LOG: Record<OpKind, string> = {
  update: '/api/install/update/log',
  upgrade: '/api/install/upgrade/log',
  purge: '/api/install/purge/log',
};

/** Log poll cadence while running (Terwo 1 s parity). */
export const INSTALL_POLL_MS = 1000;

interface LogView {
  kind: 'pkg' | OpKind;
  id: string;
  label: string;
  text: string;
  running: boolean;
}

/**
 * Static catalog grouping (client-side keyword map — the install API
 * ships no category field and the backend stays frozen; unknown ids
 * fall into Utilities so nothing ever drops out of All).
 */
export function categoryOf(id: string): string {
  if (id === 'nginx' || id === 'cloudflared' || id === '9router') return 'Web & Proxies';
  if (['nodejs', 'bun', 'golang', 'php', 'python', 'nvm', 'composer'].includes(id)) return 'Runtimes & Langs';
  if (['mysql', 'postgres', 'redis', 'sqlite'].includes(id)) return 'Databases';
  if (['cronie', 'pm2', 'tmux', 'openssh', 'termux-api'].includes(id)) return 'Daemons & System';
  return 'Utilities & Media';
}

type SortMode = 'installed' | 'name';

/**
 * Store (mockup store parity): searchable, categorized, sortable
 * package cards with install/reinstall, per-card versions, conf path
 * + Configure deep-link, Update Repo + Batch Upgrade ops reusing the
 * live log modal, mirror/latency card, storage bar, Installed Only
 * filter, ⌘K shortcut. Per-card service actions stay out (owned by
 * the services/database waves); per-env mirror detection → CAND-036;
 * purge-cache ships as a confirm-guarded third ops slot (wave 15).
 */
export function StorePage(): ReactElement {
  const [items, setItems] = useState<StoreItem[]>([]);
  const [error, setError] = useState('');
  const [logView, setLogView] = useState<LogView | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [sortMode, setSortMode] = useState<SortMode>('installed');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [diskFree, setDiskFree] = useState<number | null>(null);
  const [versions, setVersions] = useState<Record<string, string | null>>({});
  const [mirror, setMirror] = useState<MirrorInfo | null>(null);

  const loadItems = async (): Promise<void> => {
    try {
      const body = await apiJson<{ items: StoreItem[] }>('/api/install');
      setItems(body.items);
    } catch {
      // keep the previous render (Terwo parity)
    }
  };

  useEffect(() => {
    void loadItems();
    void apiJson<{ versions: Record<string, string | null> }>('/api/install/versions')
      .then((body) => {
        if (body.versions !== null && typeof body.versions === 'object') setVersions(body.versions);
      })
      .catch(() => {
        // version lines keep their placeholder
      });
    void apiJson<MirrorInfo>('/api/install/mirror')
      .then((body) => {
        if (body !== null && typeof body === 'object' && 'manager' in body) setMirror(body);
      })
      .catch(() => {
        // mirror card keeps its placeholders
      });
  }, []);

  useEffect(() => {
    let alive = true;
    void apiJson<{ disk?: { free?: unknown } }>('/api/stats', {}, { unauthorized: 'rethrow' })
      .then((body) => {
        if (alive && typeof body.disk?.free === 'number') setDiskFree(body.disk.free);
      })
      .catch(() => {
        // storage bar keeps its placeholder
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        document.getElementById('store-search')?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (logView === null || !logView.running) return undefined;
    const url = logView.kind === 'pkg' ? `/api/install/${logView.id}/log` : OP_LOG[logView.kind];
    const timer = setInterval(() => {
      void (async () => {
        try {
          const body = await apiJson<{ logs: string; running: boolean; exitCode: number | null }>(url);
          setLogView((prev) =>
            prev === null
              ? prev
              : {
                  ...prev,
                  text: body.logs,
                  running: body.running,
                },
          );
          if (!body.running) {
            setLogView((prev) =>
              prev === null ? prev : { ...prev, text: `${prev.text}\n--- done (exit ${body.exitCode}) ---\n` },
            );
            await loadItems();
          }
        } catch {
          // retry on the next tick (Terwo parity)
        }
      })();
    }, INSTALL_POLL_MS);
    return () => clearInterval(timer);
  }, [logView === null ? null : `${logView.kind}:${logView.id}`, logView?.running]);

  const openLog = async (view: Omit<LogView, 'text' | 'running'>, url: string): Promise<void> => {
    setLogView({ ...view, text: 'starting…\n', running: true });
    try {
      const body = await apiJson<{ logs: string; running: boolean; exitCode: number | null }>(url);
      setLogView({
        ...view,
        text: body.running ? body.logs : `${body.logs}\n--- done (exit ${body.exitCode}) ---\n`,
        running: body.running,
      });
      if (!body.running) await loadItems();
    } catch {
      // the interval poll retries (Terwo parity)
    }
  };

  const startInstall = async (item: StoreItem): Promise<void> => {
    setError('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>(`/api/install/${item.id}/start`, {
        method: 'POST',
      });
      if (body.ok !== true) {
        setError(typeof body.error === 'string' ? body.error : 'Failed to start install');
        return;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start install');
      return;
    }
    await openLog({ kind: 'pkg', id: item.id, label: item.name }, `/api/install/${item.id}/log`);
  };

  const startOp = async (op: OpKind): Promise<void> => {
    setError('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>(`/api/install/${op}/start`, {
        method: 'POST',
      });
      if (body.ok !== true) {
        setError(typeof body.error === 'string' ? body.error : `Failed to start ${OP_LABEL[op].toLowerCase()}`);
        return;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to start ${OP_LABEL[op].toLowerCase()}`);
      return;
    }
    await openLog({ kind: op, id: op, label: OP_LABEL[op] }, OP_LOG[op]);
  };

  const q = query.trim().toLowerCase();
  const visible = items
    .filter(
      (item) =>
        (!installedOnly || item.installed) &&
        (category === 'All' || categoryOf(item.id) === category) &&
        (q === '' || item.name.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q)),
    )
    .sort((a, b) => {
      if (sortMode === 'name') return a.name.localeCompare(b.name);
      return Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name);
    });

  return (
    <main className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">Store</h1>
        <Badge tone="info">
          {items.filter((i) => i.installed).length} installed / {items.length} total
        </Badge>
        <span className="text-xs text-neutral-400">{diskFree === null ? 'storage —' : `${fmtSize(diskFree)} free`}</span>
        <Button size="sm" variant="outline" onClick={() => void startOp('update')}>
          Update repo
        </Button>
        <Button size="sm" variant="outline" onClick={() => void startOp('upgrade')}>
          Batch upgrade
        </Button>
        <Button size="sm" variant="outline" onClick={() => setConfirmPurge(true)}>
          Purge cache
        </Button>
      </div>
      {error !== '' && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          id="store-search"
          placeholder="Search packages… (⌘K)"
          aria-label="Search packages"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          className="w-52"
        />
        <select
          aria-label="Sort packages"
          className="h-9 rounded-md border border-neutral-700 bg-transparent px-2 text-sm"
          value={sortMode}
          onChange={(ev) => setSortMode(ev.target.value as SortMode)}
        >
          <option value="installed">Installed first</option>
          <option value="name">Name A-Z</option>
        </select>
        <label className="flex items-center gap-1 text-sm text-neutral-300">
          <input type="checkbox" checked={installedOnly} onChange={(ev) => setInstalledOnly(ev.target.checked)} />
          Installed only
        </label>
      </div>
      <div className="mb-3 flex flex-wrap gap-1">
        {['All', ...Array.from(new Set(items.map((i) => categoryOf(i.id))))].map((cat) => {
          const count = cat === 'All' ? items.length : items.filter((i) => categoryOf(i.id) === cat).length;
          return (
            <Button key={cat} size="sm" variant={category === cat ? 'default' : 'outline'} onClick={() => setCategory(cat)}>
              {cat} ({count})
            </Button>
          );
        })}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {visible.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 md:col-span-3">
            <EmptyState title="No packages match." hint="Try another search or category." />
          </div>
        ) : (
          visible.map((item) => (
          <Card key={item.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold">
                  {item.name}{' '}
                  <span className="font-mono text-xs font-normal text-neutral-400">{versions[item.id] ?? '—'}</span>
                </div>
                {item.desc !== '' && <p className="mt-1 text-[13px] text-neutral-400">{item.desc}</p>}
                {item.conf !== null && (
                  <p className="mt-1 font-mono text-xs text-neutral-500">Conf: {item.conf}</p>
                )}
              </div>
              <span className={item.installing ? 'text-sm text-yellow-400' : item.installed ? 'text-sm text-green-400' : 'text-sm text-neutral-500'}>
                {item.installing ? 'Running…' : item.installed ? 'Installed' : 'Not installed'}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              <Button size="sm" variant={item.installed ? 'ghost' : 'default'} onClick={() => void startInstall(item)}>
                {item.installed ? 'Reinstall' : 'Install'}
              </Button>
              {item.conf !== null && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigateTo('files', `path=${encodeURIComponent(item.conf ?? '')}`)}
                >
                  Configure
                </Button>
              )}
            </div>
          </Card>
          ))
        )}
      </div>
      <div className="mt-3">
        <Card>
          <h2 className="mb-2 font-bold">Mirror & latency</h2>
          {mirror === null ? (
            <p className="text-sm text-neutral-400">Loading…</p>
          ) : (
            <p className="text-sm text-neutral-300">
              Manager: <span className="font-mono">{mirror.manager === null ? '—' : mirror.manager.toUpperCase()}</span>
              {' · '}Mirror: <span className="font-mono">{mirror.mirror ?? '—'}</span>
              {' · '}Latency: <span className="font-mono">{mirror.latencyMs === null ? '—' : `${mirror.latencyMs}ms`}</span>
            </p>
          )}
        </Card>
      </div>
      {logView !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-2 font-bold">{logView.kind === 'pkg' ? `Install: ${logView.label}` : logView.label}</h2>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs">{logView.text}</pre>
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => setLogView(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmPurge}
        title="Purge package cache"
        message="Remove downloaded package archives? Installed software stays. Frees disk immediately."
        confirmLabel="Purge"
        destructive={true}
        onConfirm={() => {
          setConfirmPurge(false);
          void startOp('purge');
        }}
        onCancel={() => setConfirmPurge(false)}
      />
    </main>
  );
}
