// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MonitorPage, buildExport } from '../src/pages/monitor.js';

const STATS = {
  uptime: 90061,
  cpu: { load1: 0.42 },
  mem: { total: 8000, used: 5400 },
  disk: { total: 128000, used: 45000 },
  battery: { percentage: 91, status: 'CHARGING' },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function stubStats(): void {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(STATS), { status: 200 })));
}

describe('web monitor page', () => {
  it('renders live values with tracked dummies', async () => {
    stubStats();
    await act(async () => {
      render(<MonitorPage />);
    });
    expect(screen.getByText('Monitor')).not.toBeNull();
    expect(await screen.findByText(/0\.4/)).not.toBeNull();
    expect(screen.getByText('68%')).not.toBeNull();
    expect(screen.getByText(/1d 1h/)).not.toBeNull();
    expect(screen.getByText(/91% · CHARGING/)).not.toBeNull();
    for (const id of ['CAND-014', 'CAND-002', 'CAND-001', 'CAND-004']) {
      expect(screen.getByText(id)).not.toBeNull();
    }
  });

  it('pauses the stream and switches cadence', async () => {
    stubStats();
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
