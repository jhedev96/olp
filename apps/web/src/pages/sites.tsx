import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** `/api/sites` row shape (server contract). */
export interface SiteRow {
  id: string;
  name: string;
  type: 'node' | 'php' | 'static' | 'go';
  path: string;
  port: number;
  running: boolean;
}

type SiteType = SiteRow['type'];
const SITE_TYPES: SiteType[] = ['node', 'php', 'static', 'go'];

/** Proxy row shape (server contract). */
export interface ProxyRow {
  id: string;
  name: string;
  listenPort: number;
  domain: string;
  targetPort: number;
}

/**
 * Websites + Nginx reverse proxies (Terwo website-tab parity): type tabs,
 * add modal, start/stop/restart/log/delete, log modal, nginx service
 * buttons, proxy form + delete. List failures keep the previous render;
 * destructive actions gate on `window.confirm` (dialog primitive later).
 */
export function SitesPage(): ReactElement {
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [siteType, setSiteType] = useState<SiteType>('node');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', path: '', port: '' });
  const [formError, setFormError] = useState('');
  const [logView, setLogView] = useState<{ name: string; text: string } | null>(null);
  const [nginxRunning, setNginxRunning] = useState<boolean | null>(null);
  const [proxies, setProxies] = useState<ProxyRow[]>([]);
  const [proxyForm, setProxyForm] = useState({ name: '', listen: '', domain: '', target: '' });
  const [proxyError, setProxyError] = useState('');

  const loadSites = useCallback(async (): Promise<void> => {
    try {
      const body = await apiJson<{ sites: SiteRow[] }>('/api/sites');
      setSites(body.sites);
    } catch {
      // keep the previous render on poll failure (Terwo parity)
    }
  }, []);

  const loadNginx = useCallback(async (): Promise<void> => {
    try {
      const status = await apiJson<{ running: boolean }>('/api/nginx/status');
      setNginxRunning(status.running);
    } catch {
      // keep previous
    }
    try {
      const body = await apiJson<{ proxies: ProxyRow[] }>('/api/nginx/proxies');
      setProxies(body.proxies);
    } catch {
      // keep previous
    }
  }, []);

  useEffect(() => {
    void loadSites();
    void loadNginx();
  }, [loadSites, loadNginx]);

  const act = async (id: string, action: 'start' | 'stop' | 'restart'): Promise<void> => {
    await apiJson(`/api/sites/${id}/${action}`, { method: 'POST' }).catch(() => undefined);
    await loadSites();
  };

  const remove = async (site: SiteRow): Promise<void> => {
    if (!window.confirm(`Delete website "${site.name}"? This cannot be undone.`)) return;
    await apiJson(`/api/sites/${site.id}/delete`, { method: 'POST' }).catch(() => undefined);
    await loadSites();
  };

  const saveSite = async (): Promise<void> => {
    setFormError('');
    const port = parseInt(form.port, 10);
    if (form.name.trim() === '' || form.path.trim() === '' || !Number.isInteger(port)) {
      setFormError('Fill in all fields');
      return;
    }
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name.trim(), path: form.path.trim(), port, type: siteType }),
      });
      if (body.ok === true) {
        setShowAdd(false);
        setForm({ name: '', path: '', port: '' });
        await loadSites();
      } else setFormError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const showLogs = async (site: SiteRow): Promise<void> => {
    setLogView({ name: site.name, text: 'loading…' });
    try {
      const body = await apiJson<{ logs?: unknown }>('/api/sites/' + site.id + '/logs');
      setLogView({ name: site.name, text: typeof body.logs === 'string' && body.logs !== '' ? body.logs + '\n' : 'Log empty\n' });
    } catch {
      setLogView({ name: site.name, text: 'Failed to load log' });
    }
  };

  const nginxService = async (action: 'start' | 'stop' | 'reload'): Promise<void> => {
    await apiJson('/api/nginx/service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }).catch(() => undefined);
    await loadNginx();
  };

  const saveProxy = async (): Promise<void> => {
    setProxyError('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/nginx/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: proxyForm.name.trim(),
          listenPort: parseInt(proxyForm.listen, 10),
          domain: proxyForm.domain.trim(),
          targetPort: parseInt(proxyForm.target, 10),
        }),
      });
      if (body.ok === true) {
        setProxyForm({ name: '', listen: '', domain: '', target: '' });
        await loadNginx();
      } else setProxyError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setProxyError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const removeProxy = async (proxy: ProxyRow): Promise<void> => {
    if (!window.confirm(`Delete proxy "${proxy.name}"? This cannot be undone.`)) return;
    await apiJson(`/api/nginx/proxies/${proxy.id}`, { method: 'DELETE' }).catch(() => undefined);
    await loadNginx();
  };

  const visible = sites.filter((s) => s.type === siteType);

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-bold">Websites</h1>
      <div className="mb-3 flex gap-1">
        {SITE_TYPES.map((type) => (
          <Button key={type} size="sm" variant={siteType === type ? 'default' : 'outline'} onClick={() => setSiteType(type)}>
            {type}
          </Button>
        ))}
        <span className="flex-1" />
        <Button size="sm" onClick={() => { setFormError(''); setShowAdd(true); }}>
          Add ({siteType})
        </Button>
      </div>
      <Card className="p-0">
        <table className="w-full text-sm">
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td className="text-neutral-400">No {siteType} websites yet</td>
              </tr>
            ) : (
              visible.map((site) => (
                <tr key={site.id}>
                  <td>{site.name}</td>
                  <td className="font-mono text-xs text-neutral-400">{site.path}</td>
                  <td className="text-neutral-400">{site.port}</td>
                  <td>
                    <span className={site.running ? 'text-green-400' : 'text-neutral-500'}>
                      {site.running ? 'Running' : 'Stopped'}
                    </span>
                  </td>
                  <td>
                    <div className="flex gap-1">
                      {site.running ? (
                        <>
                          <Button size="sm" variant="outline" onClick={() => void act(site.id, 'stop')}>
                            Stop
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => void act(site.id, 'restart')}>
                            Restart
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => void act(site.id, 'start')}>
                          Start
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => void showLogs(site)}>
                        Log
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => void remove(site)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      <h2 className="mb-2 mt-6 text-lg font-bold">Nginx reverse proxy</h2>
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className={nginxRunning === true ? 'text-green-400' : 'text-neutral-400'}>
          {nginxRunning === null ? '…' : nginxRunning ? 'Nginx running' : 'Nginx stopped'}
        </span>
        <Button size="sm" variant="outline" onClick={() => void nginxService('start')}>
          Start
        </Button>
        <Button size="sm" variant="outline" onClick={() => void nginxService('stop')}>
          Stop
        </Button>
        <Button size="sm" variant="outline" onClick={() => void nginxService('reload')}>
          Reload
        </Button>
      </div>
      {proxyError !== '' && (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {proxyError}
        </p>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Name" value={proxyForm.name} onChange={(ev) => setProxyForm({ ...proxyForm, name: ev.target.value })} className="w-36" />
        <Input placeholder="Listen port" value={proxyForm.listen} onChange={(ev) => setProxyForm({ ...proxyForm, listen: ev.target.value })} className="w-28" />
        <Input placeholder="Domain (optional)" value={proxyForm.domain} onChange={(ev) => setProxyForm({ ...proxyForm, domain: ev.target.value })} className="w-44" />
        <Input placeholder="Target port" value={proxyForm.target} onChange={(ev) => setProxyForm({ ...proxyForm, target: ev.target.value })} className="w-28" />
        <Button size="sm" onClick={() => void saveProxy()}>
          Add proxy
        </Button>
      </div>
      <Card className="p-0">
        <table className="w-full text-sm">
          <tbody>
            {proxies.length === 0 ? (
              <tr>
                <td className="text-neutral-400">No proxies yet</td>
              </tr>
            ) : (
              proxies.map((proxy) => (
                <tr key={proxy.id}>
                  <td>{proxy.name}</td>
                  <td className="text-neutral-400">{proxy.listenPort}</td>
                  <td className="text-neutral-400">{proxy.domain === '' ? '—' : proxy.domain}</td>
                  <td className="text-neutral-400">{proxy.targetPort}</td>
                  <td>
                    <Button size="sm" variant="destructive" onClick={() => void removeProxy(proxy)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      {showAdd && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-3 font-bold">Add Website ({siteType})</h2>
            {formError !== '' && (
              <p role="alert" className="mb-2 text-sm text-red-400">
                {formError}
              </p>
            )}
            <div className="flex flex-col gap-2">
              <Input placeholder="Site name" value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} />
              <Input placeholder="Entry file or folder" value={form.path} onChange={(ev) => setForm({ ...form, path: ev.target.value })} />
              <Input placeholder="Port" value={form.port} onChange={(ev) => setForm({ ...form, port: ev.target.value })} />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void saveSite()}>
                  Save
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowAdd(false)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      {logView !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-2 font-bold">Log: {logView.name}</h2>
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
