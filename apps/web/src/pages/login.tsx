import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtSize } from '../lib/format.js';
import { getTheme, setTheme } from '../lib/theme.js';
import { APP_VERSION } from '../lib/version.js';
import { BrandBlock } from '../components/shell/BrandBlock.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardTitle } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** Marketing stats (subset of `/api/stats` shown pre-auth when available). */
interface MarketingStats {
  hostname: string;
  cpu: { load1: number; load5: number; load15: number; cores: number };
  mem: { total: number; used: number; percent: number };
  disk: { free: number } | null;
}

/** First-boot log tail command (server prints `OLP first run` on pm2). */
export const FIRST_BOOT_CMD = 'pm2 logs olp --nostream | grep -A2 "first run"';

/** Credential reset command (fresh `config.json` regenerates on boot). */
export const RESET_CMD = 'rm -f ~/.olp/config.json && pm2 restart olp';

function isStats(body: unknown): body is MarketingStats {
  if (typeof body !== 'object' || body === null) return false;
  const s = body as Record<string, unknown>;
  const cpu = s['cpu'] as Record<string, unknown> | undefined;
  const mem = s['mem'] as Record<string, unknown> | undefined;
  return (
    typeof s['hostname'] === 'string' &&
    typeof cpu?.['load1'] === 'number' &&
    typeof cpu?.['cores'] === 'number' &&
    typeof mem?.['total'] === 'number' &&
    typeof mem?.['used'] === 'number'
  );
}

/**
 * Login gateway (mockup login parity, rebranded): shell-less two-column
 * card — marketing panel plus auth form. Marketing numbers come from
 * `/api/stats` when reachable (an authed revisit); pre-auth the request
 * 401s and the cards keep honest placeholders — never invented values.
 * CPU model/frequency, swap, and disk FS lines have no source and stay
 * out until CAND-014 telemetry lands. No rate-limit pill: the backend
 * has no limiter to report. PBKDF2 shows the true 120k rounds
 * (`packages/auth`), not the mockup's 310k.
 */
export function LoginPage({ goto }: { goto?: (url: string) => void } = {}): ReactElement {
  const go = goto ?? ((url: string): void => {
    window.location.href = url;
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [theme, setThemeState] = useState(getTheme);
  const [stats, setStats] = useState<MarketingStats | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void apiJson<unknown>('/api/stats', {}, { unauthorized: 'rethrow' })
      .then((body) => {
        if (alive && isStats(body)) {
          const disk = (body as { disk?: { free?: unknown } }).disk;
          setStats({ ...body, disk: typeof disk?.free === 'number' ? { free: disk.free } : null });
        }
      })
      .catch(() => {
        // pre-auth 401 (or offline): placeholders stay
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleTheme = (): void => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    setThemeState(next);
  };

  const copyFirstBoot = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(FIRST_BOOT_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked: the command stays visible for manual copy
    }
  };

  const submit = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body = await apiJson<{ ok?: unknown }>(
        '/api/login',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        },
        { unauthorized: 'rethrow' },
      );
      if (body.ok === true) go('/dashboard');
      else setError('Login failed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const host = typeof window === 'undefined' ? '' : window.location.host;

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-surface p-4">
      <Button variant="ghost" size="icon" className="absolute right-4 top-4" title={theme === 'light' ? 'Dark mode' : 'Light mode'} onClick={toggleTheme}>
        {theme === 'light' ? '🌙' : '☀️'}
      </Button>
      <div className="grid w-full max-w-5xl gap-4 lg:grid-cols-2">
        <section aria-label="About this panel" className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-surface-low p-6">
          <BrandBlock />
          <h1 className="text-2xl font-bold tracking-tight">OpenLocalPanel Gateway</h1>
          <p className="text-sm text-neutral-400">
            Local userland orchestrator. Enter root administrator credentials to unlock subsystems,
            memory registers, and process streams.
          </p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-md border border-neutral-800 p-2">
              <p className="text-neutral-500">CPU ARCH</p>
              <p className="mt-1 font-mono">{stats === null ? '—' : `${stats.cpu.cores} cores`}</p>
              <p className="mt-0.5 font-mono text-neutral-400">
                {stats === null ? 'load —' : `load ${stats.cpu.load1.toFixed(2)}, ${stats.cpu.load5.toFixed(2)}, ${stats.cpu.load15.toFixed(2)}`}
              </p>
            </div>
            <div className="rounded-md border border-neutral-800 p-2">
              <p className="text-neutral-500">RAM ALLOC</p>
              <p className="mt-1 font-mono">{stats === null ? '—' : `${Math.round(stats.mem.used / Math.max(stats.mem.total, 1) * 100)}%`}</p>
              <p className="mt-0.5 font-mono text-neutral-400">
                {stats === null ? '—' : `${fmtSize(stats.mem.used)} / ${fmtSize(stats.mem.total)}`}
              </p>
            </div>
            <div className="rounded-md border border-neutral-800 p-2">
              <p className="text-neutral-500">STORAGE</p>
              <p className="mt-1 font-mono">{stats?.disk ? `${fmtSize(stats.disk.free)} free` : '—'}</p>
              <p className="mt-0.5 font-mono text-neutral-400">{stats === null ? '—' : stats.hostname}</p>
            </div>
          </div>
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-neutral-300">
            <p className="font-semibold text-emerald-300">Air-gapped LAN listener active</p>
            <p className="mt-1">
              Loopback-first bind; you are on <span className="font-mono">{host === '' ? '—' : host}</span>.
              No WAN exposure without your own tunnel.
            </p>
          </div>
          <div className="rounded-md border border-neutral-800 p-3 text-xs">
            <p className="font-semibold">First-time boot credentials</p>
            <p className="mt-1 text-neutral-400">The server prints an ephemeral root password once. Fetch it via console:</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1 font-mono">{FIRST_BOOT_CMD}</code>
              <Button size="sm" variant="outline" onClick={() => void copyFirstBoot()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="mt-2 text-neutral-400">Reset local credentials:</p>
            <code className="mt-1 block truncate rounded bg-black/40 px-2 py-1 font-mono">{RESET_CMD}</code>
          </div>
          <ul className="flex flex-wrap gap-1.5 text-[11px] text-neutral-300">
            {['0 external CDNs', 'Local asset bundle', 'Non-root proot compatible', 'Salted PBKDF2 120k', 'HttpOnly cookie', 'SameSite=Lax', 'Zero telemetry'].map((badge) => (
              <li key={badge} className="rounded-full border border-neutral-700 px-2 py-0.5">{badge}</li>
            ))}
          </ul>
          <p className="mt-auto text-[11px] text-neutral-500">OpenLocalPanel v{APP_VERSION} · Node ≥22.12</p>
        </section>

        <div className="flex items-center justify-center">
          <Card className="w-full max-w-[340px]">
            <CardTitle className="text-center">OpenLocalPanel</CardTitle>
            <p className="mb-5 mt-1 text-center text-xs text-neutral-400">Local operations panel</p>
            <CardContent>
              <form onSubmit={(ev) => void submit(ev)} className="flex flex-col gap-3">
                <div className="flex gap-2">
                  <Input placeholder="Username" autoComplete="username" value={username} onChange={(ev) => setUsername(ev.target.value)} />
                  <Button type="button" variant="ghost" size="sm" aria-label="Clear username" onClick={() => setUsername('')}>
                    ✕
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    placeholder="Password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(ev) => setPassword(ev.target.value)}
                  />
                  <Button type="button" variant="ghost" size="sm" aria-label="Clear password" onClick={() => setPassword('')}>
                    ✕
                  </Button>
                </div>
                <label className="flex items-center gap-2 text-xs text-neutral-400" title="Coming soon (CAND-031)">
                  <input type="checkbox" disabled={true} />
                  Remember session (30-day cookie)
                </label>
                <Button type="submit" className="w-full" disabled={busy}>
                  Authenticate
                </Button>
              </form>
              {error !== '' && (
                <p role="alert" className="mt-3 text-sm text-red-400">
                  {error}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="outline" disabled={true} title="Coming soon (CAND-032)" className="flex-1">
                  Hardware passkey
                </Button>
                <Button size="sm" variant="outline" disabled={true} title="Coming soon (CAND-032)" className="flex-1">
                  Local pipe auth
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
