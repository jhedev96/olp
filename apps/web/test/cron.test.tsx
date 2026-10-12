// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { CronPage } from '../src/pages/cron.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function stubApi(handler: (url: string, method: string, body: unknown) => { status: number; json: unknown }): { calls: Array<{ url: string; method: string; body: unknown }> } {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const body = init?.body !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const { status, json } = handler(url, init?.method ?? 'GET', body);
    return Promise.resolve(new Response(JSON.stringify(json), { status }));
  });
  return { calls };
}

const JOBS = {
  jobs: [
    { id: 'a1', name: 'nightly', schedule: '0 2 * * *', command: '/bin/sync', enabled: true },
    { id: 'b2', name: 'old', schedule: '* * * * *', command: '/bin/x', enabled: false },
  ],
};

function base(url: string): { status: number; json: unknown } {
  if (url === '/api/cron/status') return { status: 200, json: { running: true } };
  if (url === '/api/cron/daemon') return { status: 200, json: { running: true, pid: 24108 } };
  if (url === '/api/cron/jobs') return { status: 200, json: { jobs: JOBS.jobs.map((j) => ({ ...j, nextRun: Date.now() + 60000 })) } };
  if (url.startsWith('/api/cron/runs')) return { status: 200, json: { runs: [] } };
  if (url === '/api/stats') return { status: 200, json: { battery: { percentage: 80, status: 'DISCHARGING' } } };
  return { status: 200, json: { ok: true, job: { id: 'c3' } } };
}

describe('web cron page', () => {
  it('shows status and jobs with toggle states', async () => {
    stubApi((url) => base(url));
    await act(async () => {
      render(<CronPage />);
    });
    expect(screen.getByText('crond running')).not.toBeNull();
    expect(screen.getByText('nightly')).not.toBeNull();
    expect(screen.getByText('Enabled')).not.toBeNull();
    expect(screen.getByText('Stopped')).not.toBeNull();
    expect(screen.getByText('Disable')).not.toBeNull();
    expect(screen.getByText('Enable')).not.toBeNull();
    expect(screen.getAllByText('Copy')).toHaveLength(2);
  });

  it('uses presets and unlocks custom input', async () => {
    stubApi((url) => base(url));
    await act(async () => {
      render(<CronPage />);
    });
    const custom = screen.getByPlaceholderText('* * * * *') as HTMLInputElement;
    expect(custom.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Schedule preset'), { target: { value: 'custom' } });
    expect((screen.getByPlaceholderText('* * * * *') as HTMLInputElement).disabled).toBe(false);
  });

  it('adds jobs with the resolved schedule', async () => {
    const { calls } = stubApi((url) => base(url));
    await act(async () => {
      render(<CronPage />);
    });
    fireEvent.change(screen.getByPlaceholderText('Job name'), { target: { value: 'j' } });
    fireEvent.change(screen.getByPlaceholderText('Command'), { target: { value: '/bin/a' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Add job'));
    });
    const save = calls.find((c) => c.url === '/api/cron/jobs' && c.method === 'POST');
    expect(save?.body).toMatchObject({ name: 'j', schedule: '* * * * *', command: '/bin/a' });
  });

  it('toggles and deletes with dialog', async () => {
    const { calls } = stubApi((url) => base(url));
    await act(async () => {
      render(<CronPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Disable'));
    });
    expect(calls.some((c) => c.url === '/api/cron/jobs/a1/toggle')).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('This cannot be undone.');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(calls.some((c) => c.url === '/api/cron/jobs/a1')).toBe(true);
  });

  it('controls the service', async () => {
    const { calls } = stubApi((url) => base(url));
    await act(async () => {
      render(<CronPage />);
    });
    const stops = screen.getAllByText('Stop');
    await act(async () => {
      fireEvent.click(stops[stops.length - 1] as HTMLElement);
    });
    expect(calls.some((c) => c.url === '/api/cron/service')).toBe(true);
  });

  it('searches, filters and previews the crontab', async () => {
    stubApi((url) => base(url));
    await act(async () => {
      render(<CronPage />);
    });
    expect(screen.queryByText('CAND-028')).toBeNull();
    expect(screen.getByText(/Next in/)).not.toBeNull();
    expect(screen.getByText('PID 24108')).not.toBeNull();
    expect(screen.getByText(/Battery 80%/)).not.toBeNull();
    expect(screen.getByText(/panel-triggered runs only/)).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Search jobs'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Search jobs'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByText('View crontab'));
    });
    expect(screen.getByText('Crontab (read-only)')).not.toBeNull();
    expect(screen.getByText(/0 2 \* \* \* \/bin\/sync/)).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Close'));
    });
    expect(screen.queryByText('Crontab (read-only)')).toBeNull();
  });

  it('dry-runs all jobs and runs one now', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      let json: unknown = base(url).json;
      if (url === '/api/cron/jobs/dry-run') {
        json = { results: [{ id: 'a1', name: 'nightly', enabled: true, ok: true, nextRun: 1, resolved: true, error: null }] };
      }
      if (url === '/api/cron/jobs/a1/run') {
        json = { ok: true, run: { exitCode: 0, latencyMs: 12 } };
      }
      return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));
    });
    await act(async () => {
      render(<CronPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Dry-run all'));
    });
    expect(screen.getByText('Dry-run results')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Close'));
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Run now')[0] as HTMLElement);
    });
    expect(calls).toContain('POST /api/cron/jobs/a1/run');
    expect(screen.getByText(/Ran nightly: exit 0 in 12ms/)).not.toBeNull();
  });
});
