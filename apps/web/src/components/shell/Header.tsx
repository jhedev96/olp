import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Router, Server, SquareTerminal, User, createIcons } from 'lucide';
import { apiJson } from '../../lib/api.js';
import { navigateTo } from '../../lib/router.js';

/** Tree-shaken icon set for the header (passed to `createIcons` per render). */
const ICONS = { Router, Server, SquareTerminal, User };

/**
 * App header (mockup header parity): HOST pill from `/api/stats`,
 * IP pill from `location.host` (no endpoint needed), quick-terminal
 * shortcut, active-session pill, decorative avatar (CAND-011 — the
 * single-admin panel has no user profiles).
 */
export function Header({ title }: { title: string }): ReactElement {
  const [hostname, setHostname] = useState('—');

  useEffect(() => {
    createIcons({ icons: ICONS });
  });

  useEffect(() => {
    let alive = true;
    void apiJson<{ hostname: string }>('/api/stats')
      .then((body) => {
        if (alive) setHostname(body.hostname);
      })
      .catch(() => {
        // keep the placeholder (dashboard poll retries on its cadence)
      });
    return () => {
      alive = false;
    };
  }, []);

  const host = typeof window === 'undefined' ? '' : window.location.host;

  return (
    <header className="sticky top-0 z-40 flex flex-wrap items-center gap-2 border-b border-neutral-800 bg-surface-lowest/80 px-4 py-2.5 backdrop-blur">
      <h1 className="mr-auto text-sm font-semibold tracking-tight">{title}</h1>
      <span className="hidden items-center gap-1.5 rounded-full border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 sm:flex">
        <i data-lucide="server" className="h-3.5 w-3.5" />
        HOST: <span className="font-mono">{hostname}</span>
      </span>
      <span className="hidden items-center gap-1.5 rounded-full border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 lg:flex">
        <i data-lucide="router" className="h-3.5 w-3.5" />
        IP: <span className="font-mono">{host}</span>
      </span>
      <button
        type="button"
        onClick={() => navigateTo('terminal')}
        className="flex items-center gap-1.5 rounded-full border border-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
      >
        <i data-lucide="square-terminal" className="h-3.5 w-3.5" />
        Quick Terminal
      </button>
      <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 px-2.5 py-1 text-xs text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        Active Session
      </span>
      <span title="Account (single admin, no profiles)" className="flex h-7 w-7 items-center justify-center rounded-full border border-neutral-700 text-neutral-400">
        <i data-lucide="user" className="h-4 w-4" />
      </span>
    </header>
  );
}
