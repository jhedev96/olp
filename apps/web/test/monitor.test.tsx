// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MonitorPage, buildExport } from '../src/pages/monitor.js';

const SUMMARY = {
  hostname: 'monbox',
  uptime: 90061,
  arch: 'x64',
  kernel: '6.1.0-test',
  cpu: {
    load1: 0.42,
    cores: 2,
    perCore: [
      { index: 0, percent: 34, freqMhz: 1800 },
      { index: 1, percent: null, freqMhz: null },
    ],
    model: 'Test CPU',
    tempC: 38.5,
  },
  mem: { total: 8000, used: 5400, swapTotal: 2000, swapFree: 1800 },
  disk: { total: 128000, used: 45000, io: { readRateBps: 18000000, writeRateBps: 6400000 } },
  net: {
    interfaces: [{ name: 'wlan0', rxBytes: 42000000, txBytes: 18400000, rxRateBps: 2400000, upRateBps: 0, txRateBps: 840000 }],
    listeningPorts: [8080, 3306],
  },
  battery: { percentage: 91, status: 'CHARGING' },
};

const PROCS = {
  processes: [{ pid: 42, command: 'node worker.js', cpuPercent: 1.4, memBytes: 142000 * 1024, uptimeSec: 3661 }],
  pm2: [{ name: 'api', pid: 7, status: 'online', cpuPercent: 0.5, memBytes: 1000 }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function stubMonitor(): void {
  vi.stubGlobal('fetch', (url: string) => {
    const body = url.startsWith('/api/monitor/processes') ? PROCS : SUMMARY;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

describe('web monitor page', () => {
  it('renders live telemetry with per-row kill', async () => {
    stubMonitor();
    await act(async () => {
      render(<MonitorPage />);
    });
    expect(screen.getByText('Monitor')).not.toBeNull();
    expect(await screen.findByText(/0\.4/)).not.toBeNull();
    expect(screen.getByText(/Test CPU/)).not.toBeNull();
    expect(screen.getByText(/38\.5°C/)).not.toBeNull();
    expect(screen.getByText('68%')).not.toBeNull();
    expect(screen.getByText(/1d 1h/)).not.toBeNull();
    expect(screen.getByText(/91% · CHARGING/)).not.toBeNull();
    expect(screen.getByText('node worker.js')).not.toBeNull();
    expect(screen.getByText('api')).not.toBeNull();
    expect(screen.getByText('wlan0')).not.toBeNull();
    expect(screen.getByText(/LISTEN :8080 :3306/)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Kill' })).not.toBeNull();
    expect(screen.queryByText('CAND-001')).toBeNull();
    expect(screen.queryByText('CAND-002')).toBeNull();
    expect(screen.queryByText('CAND-004')).toBeNull();
    expect(screen.queryByText('CAND-014')).toBeNull();
  });

  it('confirms kills per row and refreshes the table', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const body = url.startsWith('/api/monitor/processes') && (init?.method ?? 'GET') === 'GET' ? PROCS : url.includes('/kill') ? { ok: true, pid: 42, signal: 'TERM' } : SUMMARY;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    await act(async () => {
      render(<MonitorPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Kill PID 42 (node worker.js)?');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Kill' }));
    });
    expect(calls).toContain('POST /api/monitor/processes/42/kill');
  });

  it('pauses the stream and switches cadence', async () => {
    stubMonitor();
    await act(async () => {
      render(<MonitorPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause stream' }));
    });
    expect(screen.getByText('Paused')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Refresh cadence'), { target: { value: '5000' } });
    expect(screen.getByText(/sampled every 5s/)).not.toBeNull();
  });

  it('serializes samples for export', () => {
    const json = buildExport(1000, [{ t: 'now', v: 0.5 }]);
    expect(JSON.parse(json)).toMatchObject({ cadenceMs: 1000, samples: [{ t: 'now', v: 0.5 }] });
  });
});
