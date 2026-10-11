import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Activity,
  Archive,
  CalendarClock,
  Database,
  Folder,
  Globe,
  LayoutDashboard,
  LogOut,
  Moon,
  MoreHorizontal,
  Settings,
  SquareTerminal,
  Store,
  Sun,
  Terminal,
  X,
  createIcons,
} from 'lucide';
import { apiJson } from '../../lib/api.js';
import { navigateTo } from '../../lib/router.js';
import type { Slug } from '../../lib/router.js';
import { getTheme, setTheme } from '../../lib/theme.js';
import { BrandBlock } from './BrandBlock.js';

/** Tree-shaken icon set for the sidebar (passed to `createIcons` per render). */
const ICONS = {
  Activity,
  Archive,
  CalendarClock,
  Database,
  Folder,
  Globe,
  LayoutDashboard,
  LogOut,
  Moon,
  MoreHorizontal,
  Settings,
  SquareTerminal,
  Store,
  Sun,
  Terminal,
  X,
};

/**
 * Sidebar nav in mockup order (dashboard first, settings near-last),
 * plus `monitor` appended (locked decision — the mockup has no monitor
 * entry). `data-path` carries the OLP slug: the mockup mobile bar uses
 * the plural `websites`, but the router slug `website` wins (locked).
 */
export const NAV_ITEMS: ReadonlyArray<{ slug: Exclude<Slug, 'login'>; label: string; icon: string }> = [
  { slug: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
  { slug: 'website', label: 'Websites', icon: 'globe' },
  { slug: 'database', label: 'Database', icon: 'database' },
  { slug: 'files', label: 'Files', icon: 'folder' },
  { slug: 'terminal', label: 'Terminal', icon: 'terminal' },
  { slug: 'store', label: 'Store', icon: 'store' },
  { slug: 'cron', label: 'Cron', icon: 'calendar-clock' },
  { slug: 'backup', label: 'Backup', icon: 'archive' },
  { slug: 'settings', label: 'Settings', icon: 'settings' },
  { slug: 'monitor', label: 'Monitor', icon: 'activity' },
];

/**
 * Mobile bottom-bar tabs (mockup mobile parity: 5 primary + More).
 * Short labels fit narrow phones; `data-path` keeps the OLP slug.
 */
export const MOBILE_TABS: ReadonlyArray<{ slug: Exclude<Slug, 'login'>; short: string; icon: string }> = [
  { slug: 'dashboard', short: 'Dash', icon: 'layout-dashboard' },
  { slug: 'website', short: 'Web', icon: 'globe' },
  { slug: 'database', short: 'Data', icon: 'database' },
  { slug: 'files', short: 'Files', icon: 'folder' },
  { slug: 'terminal', short: 'Shell', icon: 'terminal' },
];

/** Overflow entries behind the mobile More sheet. */
export const MORE_ITEMS: ReadonlyArray<{ slug: Exclude<Slug, 'login'>; label: string; icon: string }> = [
  { slug: 'store', label: 'Store', icon: 'store' },
  { slug: 'cron', label: 'Cron', icon: 'calendar-clock' },
  { slug: 'backup', label: 'Backup', icon: 'archive' },
  { slug: 'settings', label: 'Settings', icon: 'settings' },
  { slug: 'monitor', label: 'Monitor', icon: 'activity' },
];
/** Page title per slug (header lookup, single source with the nav). */
export function titleFor(slug: Slug): string {
  if (slug === 'login') return 'Login';
  return NAV_ITEMS.find((item) => item.slug === slug)?.label ?? 'Dashboard';
}

/** Port suffix from the current host (`:8080`), empty when host-only. */
export function portSuffix(host: string): string {
  const port = host.split(':')[1] ?? '';
  return port === '' ? '' : `:${port}`;
}

/**
 * App sidebar (mockup sidebar parity): brand block, online pill, nav,
 * theme toggle, quick-terminal shortcut, logout. Below `md` the rail
 * hides and a 6-tab bottom bar takes over (mockup mobile parity: 5
 * primary tabs + a More sheet with the rest, theme toggle, and logout
 * — the rail-only controls stay reachable on phones).
 */
export function Sidebar({
  slug,
  goto,
}: {
  slug: Slug;
  goto?: (url: string) => void;
}): ReactElement {
  const go =
    goto ??
    ((url: string): void => {
      window.location.href = url;
    });
  const [theme, setThemeState] = useState(getTheme);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    createIcons({ icons: ICONS });
  });

  const toggleTheme = (): void => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    setThemeState(next);
  };

  const logout = async (): Promise<void> => {
    await apiJson('/api/logout', { method: 'POST' }).catch(() => undefined);
    go('/login');
  };

  const host = typeof window === 'undefined' ? '' : window.location.host;
  const moreActive = MORE_ITEMS.some((item) => item.slug === slug);
  const currentMore = MORE_ITEMS.find((item) => item.slug === slug);
  const goSlug = (target: Slug): void => {
    setMoreOpen(false);
    navigateTo(target);
  };
  const link = (item: { slug: Slug; label: string; icon: string }): ReactElement => {
    const active = item.slug === slug;
    return (
      <a
        key={item.slug}
        href={`/${item.slug}`}
        data-path={item.slug}
        aria-current={active ? 'page' : undefined}
        onClick={(ev) => {
          ev.preventDefault();
          navigateTo(item.slug);
        }}
        className={
          active
            ? 'flex items-center gap-2 rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-neutral-950'
            : 'flex items-center gap-2 rounded-md px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800'
        }
      >
        <i data-lucide={item.icon} className="h-4 w-4" />
        {item.label}
      </a>
    );
  };

  return (
    <>
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-neutral-800 bg-surface-lowest p-4 md:flex">
        <BrandBlock />
        <p className="mt-3 flex items-center gap-2 text-xs text-neutral-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          Online <span className="font-mono">{portSuffix(host)}</span>
        </p>
        <nav aria-label="Primary" className="mt-4 flex flex-col gap-1">
          {NAV_ITEMS.map(link)}
        </nav>
        <div className="mt-auto flex items-center gap-2 border-t border-neutral-800 pt-3">
          <button
            type="button"
            title={theme === 'light' ? 'Dark mode' : 'Light mode'}
            onClick={toggleTheme}
            className="rounded-md p-2 text-neutral-300 hover:bg-neutral-800"
          >
            <i data-lucide={theme === 'light' ? 'moon' : 'sun'} className="h-4 w-4" />
          </button>
          <a
            href="/terminal"
            title="Quick Terminal"
            onClick={(ev) => {
              ev.preventDefault();
              navigateTo('terminal');
            }}
            className="rounded-md p-2 text-neutral-300 hover:bg-neutral-800"
          >
            <i data-lucide="square-terminal" className="h-4 w-4" />
          </a>
          <button
            type="button"
            title="Logout"
            onClick={() => void logout()}
            className="rounded-md p-2 text-neutral-300 hover:bg-neutral-800"
          >
            <i data-lucide="log-out" className="h-4 w-4" />
          </button>
        </div>
      </aside>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-50 flex items-stretch justify-around border-t border-neutral-800 bg-surface-lowest/95 px-1 py-1 backdrop-blur md:hidden"
      >
        {MOBILE_TABS.map((item) => {
          const active = item.slug === slug;
          return (
            <a
              key={item.slug}
              href={`/${item.slug}`}
              data-path={item.slug}
              aria-current={active ? 'page' : undefined}
              onClick={(ev) => {
                ev.preventDefault();
                goSlug(item.slug);
              }}
              className={
                active
                  ? 'flex flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-emerald-300'
                  : 'flex flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-[11px] text-neutral-400 hover:bg-neutral-800'
              }
            >
              <i data-lucide={item.icon} className="h-5 w-5" />
              {item.short}
            </a>
          );
        })}
        <button
          type="button"
          aria-label={currentMore ? currentMore.label : 'More'}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
          className={
            moreActive || moreOpen
              ? 'flex flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-emerald-300'
              : 'flex flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-[11px] text-neutral-400 hover:bg-neutral-800'
          }
        >
          <i data-lucide={currentMore ? currentMore.icon : moreOpen ? 'x' : 'more-horizontal'} className="h-5 w-5" />
          {currentMore ? currentMore.label : 'More'}
        </button>
      </nav>
      {moreOpen && (
        <div className="fixed inset-x-0 bottom-16 z-50 px-4 md:hidden">
          <div role="menu" aria-label="More destinations" className="rounded-lg border border-neutral-700 bg-surface-low p-2 shadow-xl">
            {MORE_ITEMS.map((item) => (
              <a
                key={item.slug}
                href={`/${item.slug}`}
                data-path={item.slug}
                aria-current={item.slug === slug ? 'page' : undefined}
                onClick={(ev) => {
                  ev.preventDefault();
                  goSlug(item.slug);
                }}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800"
              >
                <i data-lucide={item.icon} className="h-4 w-4" />
                {item.label}
              </a>
            ))}
            <div className="mt-1 flex items-center gap-2 border-t border-neutral-800 pt-2">
              <button
                type="button"
                title={theme === 'light' ? 'Dark mode' : 'Light mode'}
                onClick={toggleTheme}
                className="rounded-md p-2 text-neutral-300 hover:bg-neutral-800"
              >
                <i data-lucide={theme === 'light' ? 'moon' : 'sun'} className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="Logout"
                onClick={() => void logout()}
                className="rounded-md p-2 text-neutral-300 hover:bg-neutral-800"
              >
                <i data-lucide="log-out" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
