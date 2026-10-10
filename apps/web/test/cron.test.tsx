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
  if (url === '/api/cron/jobs') return { status: 200, json: JOBS };
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
    console.log('DBG LEN:', calls.length, 'ISARR:', Array.isArray(calls), 'FIND:', typeof calls.find);
    console.log('DBG URLS:', JSON.stringify(calls.map((c) => [typeof c.url, c.url])));
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
});
