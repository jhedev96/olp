// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DashboardPage } from '../src/pages/dashboard.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const STATS = {
  hostname: 'dashbox',
  uptime: 3661,
  time: 1728470400000,
  cpu: { load1: 1.234, load5: 0.5, load15: 0.25, cores: 4 },
  mem: { total: 8000, free: 2000, used: 6000, percent: 75 },
  disk: { total: 4000, free: 3000, used: 1000, percent: 25 },
  battery: { percentage: 87, status: 'CHARGING' },
};

const SITES = {
  sites: [
    { name: 'web', type: 'node', path: 'server.js', port: 3000, running: true },
    { name: 'blog', type: 'php', path: 'blog', port: 4000, running: false },
  ],
};

function stubApi(handler: (url: string) => unknown): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    (url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify(handler(url)), { status: 200 }));
    },
  );
  return { calls };
}

const STORE = {
  items: [
    { id: 'nginx', name: 'nginx', installed: true },
    { id: 'node', name: 'node', installed: false },
  ],
};

function dashboardHandler(url: string): unknown {
  if (url === '/api/stats') return STATS;
  if (url === '/api/install') return STORE;
  if (url === '/api/settings') return { telegram: { enabled: true } };
  return SITES;
}

describe('web dashboard page', () => {
  it('renders cards and the sites table', async () => {
    stubApi(dashboardHandler);
    await act(async () => {
      render(<DashboardPage />);
    });
    expect(screen.getByText('1.23')).not.toBeNull();
    expect(screen.getByText('75%')).not.toBeNull();
    expect(screen.getByText('87%')).not.toBeNull();
    expect(screen.getByText('1h 1m')).not.toBeNull();
    expect(screen.getByText('web')).not.toBeNull();
    expect(screen.getByText('Running')).not.toBeNull();
    expect(screen.getByText('Stopped')).not.toBeNull();
  });

  it('degrades disk and battery gracefully', async () => {
    stubApi((url) =>
      url === '/api/stats' ? { ...STATS, disk: null, battery: { error: 'unavailable' } } : { sites: [] },
    );
    await act(async () => {
      render(<DashboardPage />);
    });
    expect(screen.getByText('No websites yet')).not.toBeNull();
    expect(screen.getByText('unavailable')).not.toBeNull();
  });

  it('polls every 5 s and cleans up on unmount', async () => {
    vi.useFakeTimers();
    try {
      const { calls } = stubApi((url) => (url === '/api/stats' ? STATS : SITES));
      let unmount = (): void => {};
      await act(async () => {
        const rendered = render(<DashboardPage />);
        unmount = rendered.unmount;
      });
      await act(async () => {
        await Promise.resolve();
      });
      const initial = calls.filter((c) => c === '/api/stats').length;
      expect(initial).toBeGreaterThanOrEqual(1);
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(calls.filter((c) => c === '/api/stats').length).toBe(initial + 1);
      unmount();
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });
      expect(calls.filter((c) => c === '/api/stats').length).toBe(initial + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps placeholders when polling fails', async () => {
    stubApi(() => {
      throw new Error('down');
    });
    await act(async () => {
      render(<DashboardPage />);
    });
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('No websites yet')).not.toBeNull();
  });

  it('shows the store preview with tracked dummies', async () => {
    stubApi(dashboardHandler);
    await act(async () => {
      render(<DashboardPage />);
    });
    expect(screen.getByText('2 available')).not.toBeNull();
    expect(screen.getByText('Installed')).not.toBeNull();
    expect(screen.getByText('CAND-005')).not.toBeNull();
    expect(screen.getByText('CAND-013')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Restart panel' })).toHaveProperty('disabled', true);
  });

  it('filters sites, links proxies and shows telegram state', async () => {
    stubApi(dashboardHandler);
    await act(async () => {
      render(<DashboardPage />);
    });
    expect(screen.getByText('server.js')).not.toBeNull();
    expect(screen.getByText('Telegram alerts on')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'php' }));
    });
    expect(screen.queryByText('web')).toBeNull();
    expect(screen.getAllByText('blog').length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByText('Configure Reverse Proxy →'));
    });
    expect(window.location.pathname).toBe('/website');
  });
});
