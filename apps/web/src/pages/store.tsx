import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';

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
 * Store (Terwo install-tab parity): package cards with install/reinstall,
 * live log modal polling every second while running, list refresh on
 * finish. Start failures surface inline (Terwo `alert()`s — deliberate
 * improvement, same information).
 */
export function StorePage(): ReactElement {
  const [items, setItems] = useState<StoreItem[]>([]);
  const [error, setError] = useState('');
  const [logView, setLogView] = useState<LogView | null>(null);

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

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-bold">Store</h1>
      {error !== '' && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-3">
        {items.map((item) => (
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
        ))}
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
