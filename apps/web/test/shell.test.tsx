// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from '../src/components/shell/AppShell.js';
import { BrandBlock } from '../src/components/shell/BrandBlock.js';
import { Sidebar, portSuffix, titleFor } from '../src/components/shell/Sidebar.js';
import { Header } from '../src/components/shell/Header.js';
import { navigateTo, slugFromPath } from '../src/lib/router.js';
import { MonitorPage } from '../src/pages/monitor.js';

const ORDER = [
  'dashboard',
  'website',
  'database',
  'files',
  'terminal',
  'store',
  'cron',
  'backup',
  'settings',
  'monitor',
];

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.documentElement.classList.remove('light');
  window.localStorage.clear();
  window.history.replaceState({}, '', '/dashboard');
});

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(handler(url, init)), { status: 200 }),
    );
  });
  return calls;
}

describe('web router monitor slug', () => {
  it('maps /monitor and keeps the dashboard fallback', () => {
    expect(slugFromPath('/monitor')).toBe('monitor');
    expect(slugFromPath('/nope')).toBe('dashboard');
  });

  it('navigateTo pushes history and notifies via popstate', () => {
    const seen: string[] = [];
    window.addEventListener('popstate', () => seen.push(window.location.pathname));
    navigateTo('monitor');
    expect(window.location.pathname).toBe('/monitor');
    expect(seen).toEqual(['/monitor']);
  });
});

describe('web shell brand block', () => {
  it('renders the self-hosted logo with version badge', () => {
    render(<BrandBlock />);
    const img = screen.getByAltText('OpenLocalPanel');
    expect(img.getAttribute('src')).toContain('logo');
    expect(img.getAttribute('src')).not.toMatch(/^https?:/);
    expect(screen.getByText('v2.0.0-alpha.1')).not.toBeNull();
  });
});

describe('web shell sidebar', () => {
  it('renders nav in mockup order with the active slug highlighted', () => {
    stubFetch(() => ({}));
    const { container } = render(<Sidebar slug="files" />);
    const desktop = container.querySelector('aside nav');
    const paths = Array.from(desktop?.querySelectorAll('a') ?? []).map((a) =>
      a.getAttribute('data-path'),
    );
    expect(paths).toEqual(ORDER);
    const active = Array.from(container.querySelectorAll('[aria-current="page"]')).map((a) =>
      a.getAttribute('data-path'),
    );
    expect(active).toEqual(['files', 'files']);
  });

  it('exposes titles and port suffixes', () => {
    expect(titleFor('monitor')).toBe('Monitor');
    expect(titleFor('login')).toBe('Login');
    expect(titleFor('website')).toBe('Websites');
    expect(portSuffix('panel:8080')).toBe(':8080');
    expect(portSuffix('localhost')).toBe('');
  });

  it('toggles the theme', async () => {
    stubFetch(() => ({}));
    render(<Sidebar slug="dashboard" />);
    await act(async () => {
      fireEvent.click(screen.getByTitle('Light mode'));
    });
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('logs out via the session endpoint then returns to login', async () => {
    const calls = stubFetch(() => ({ ok: true }));
    const seen: string[] = [];
    render(<Sidebar slug="dashboard" goto={(url) => seen.push(url)} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle('Logout'));
    });
    expect(calls).toContain('/api/logout');
    expect(seen).toEqual(['/login']);
  });

  it('navigates without reloading', () => {
    stubFetch(() => ({}));
    const { container } = render(<Sidebar slug="dashboard" />);
    const target = container.querySelector('aside nav a[data-path="terminal"]');
    expect(target?.getAttribute('href')).toBe('/terminal');
    fireEvent.click(target!);
    expect(window.location.pathname).toBe('/terminal');
  });
});

describe('web shell header', () => {
  it('shows host, ip, session and quick terminal', async () => {
    stubFetch((url) => (url === '/api/stats' ? { hostname: 'testbox' } : {}));
    render(<Header title="Dashboard" />);
    expect(screen.getByText('Dashboard')).not.toBeNull();
    expect(await screen.findByText('testbox')).not.toBeNull();
    expect(screen.getByText(window.location.host)).not.toBeNull();
    expect(screen.getByText('Active Session')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Quick Terminal' }));
    });
    expect(window.location.pathname).toBe('/terminal');
  });
});

describe('web app shell', () => {
  it('wraps the page with sidebar, header and outlet', async () => {
    stubFetch((url) => (url === '/api/stats' ? { hostname: 'testbox' } : {}));
    const { container } = render(
      <AppShell slug="monitor">
        <p>outlet-child</p>
      </AppShell>,
    );
    expect(container.querySelector('header h1')?.textContent).toBe('Monitor');
    expect(screen.getByText('outlet-child')).not.toBeNull();
    expect(await screen.findByText('testbox')).not.toBeNull();
    expect(container.querySelector('aside nav')).not.toBeNull();
  });

  it('ships no legacy brand strings', async () => {
    stubFetch(() => ({ hostname: 'testbox' }));
    const { container } = render(
      <AppShell slug="dashboard">
        <p>child</p>
      </AppShell>,
    );
    await act(async () => {});
    expect(container.textContent).not.toMatch(/terwo/i);
  });
});

describe('web monitor page', () => {
  it('renders the placeholder with candidate refs', () => {
    render(<MonitorPage />);
    expect(screen.getByText('Monitor')).not.toBeNull();
    expect(screen.getByText(/CAND-014/)).not.toBeNull();
  });
});
