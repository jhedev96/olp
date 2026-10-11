import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtSize } from '../lib/format.js';
import { ComingSoon } from '../components/common/States.js';
import { Badge } from '../components/common/Badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** `/api/install` item shape (server contract). */
export interface StoreItem {
  id: string;
  name: string;
  desc: string;
  installed: boolean;
  installing: boolean;
}

/** Log poll cadence while running (Terwo 1 s parity). */
export const INSTALL_POLL_MS = 1000;

interface LogView {
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
 * package cards with install/reinstall, live log modal, storage bar,
 * mirror/latency + repo-upgrade dummies (CAND-027). Installed versions
 * and conf paths have no source and stay out until CAND-027.
 */
export function StorePage(): ReactElement {
  const [items, setItems] = useState<StoreItem[]>([]);
  const [error, setError] = useState('');
  const [logView, setLogView] = useState<LogView | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [sortMode, setSortMode] = useState<SortMode>('installed');
  const [diskFree, setDiskFree] = useState<number | null>(null);

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
    const timer = setInterval(() => {
      void (async () => {
        try {
          const body = await apiJson<{ logs: string; running: boolean; exitCode: number | null }>(
            `/api/install/${logView.id}/log`,
          );
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
  }, [logView === null ? null : logView.id, logView?.running]);

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
    setLogView({ id: item.id, label: item.name, text: 'starting…\n', running: true });
    try {
      const body = await apiJson<{ logs: string; running: boolean; exitCode: number | null }>(
        `/api/install/${item.id}/log`,
      );
      setLogView({
        id: item.id,
        label: item.name,
        text: body.running ? body.logs : `${body.logs}\n--- done (exit ${body.exitCode}) ---\n`,
        running: body.running,
      });
      if (!body.running) await loadItems();
    } catch {
      // the interval poll retries (Terwo parity)
    }
  };

  const q = query.trim().toLowerCase();
  const visible = items
    .filter(
      (item) =>
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
        <Button size="sm" variant="outline" disabled={true} title="Coming soon (CAND-027)">
          Update repo
        </Button>
        <Button size="sm" variant="outline" disabled={true} title="Coming soon (CAND-027)">
          Batch upgrade
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
          <p className="text-sm text-neutral-400">No packages match.</p>
        ) : (
          visible.map((item) => (
          <Card key={item.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold">{item.name}</div>
                {item.desc !== '' && <p className="mt-1 text-[13px] text-neutral-400">{item.desc}</p>}
              </div>
              <span className={item.installing ? 'text-sm text-yellow-400' : item.installed ? 'text-sm text-green-400' : 'text-sm text-neutral-500'}>
                {item.installing ? 'Running…' : item.installed ? 'Installed' : 'Not installed'}
              </span>
            </div>
            <div className="mt-3">
              <Button size="sm" variant={item.installed ? 'ghost' : 'default'} onClick={() => void startInstall(item)}>
                {item.installed ? 'Reinstall' : 'Install'}
              </Button>
            </div>
          </Card>
          ))
        )}
      </div>
      <div className="mt-3">
        <ComingSoon feature="Mirror & latency" candidate="CAND-027" />
      </div>
      {logView !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-2 font-bold">Install: {logView.label}</h2>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs">{logView.text}</pre>
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => setLogView(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
