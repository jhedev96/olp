// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StorePage } from '../src/pages/store.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const ITEMS = {
  items: [
    { id: 'nginx', name: 'Nginx', desc: 'Web server', installed: true, installing: false },
    { id: 'php', name: 'PHP', desc: '', installed: false, installing: false },
  ],
};

function stubApi(handler: (url: string, method: string) => { status: number; json: unknown }): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const { status, json } = handler(url, init?.method ?? 'GET');
    return Promise.resolve(new Response(JSON.stringify(json), { status }));
  });
  return { calls };
}

describe('web store page', () => {
  it('renders cards with install vs reinstall', async () => {
    stubApi(() => ({ status: 200, json: ITEMS }));
    await act(async () => {
      render(<StorePage />);
    });
    expect(screen.getByText('Nginx')).not.toBeNull();
    expect(screen.getByText('Installed')).not.toBeNull();
    expect(screen.getByText('Reinstall')).not.toBeNull();
    expect(screen.getByText('Not installed')).not.toBeNull();
    expect(screen.getByText('Install')).not.toBeNull();
  });

  it('streams install logs and refreshes on finish', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      stubApi((url) => {
        if (url === '/api/install') return { status: 200, json: ITEMS };
        if (url === '/api/install/php/start') return { status: 200, json: { ok: true } };
        polls++;
        return polls < 2
          ? { status: 200, json: { logs: 'step 1\n', running: true, exitCode: null } }
          : { status: 200, json: { logs: 'step 1\nstep 2\n', running: false, exitCode: 0 } };
      });
      await act(async () => {
        render(<StorePage />);
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Install'));
      });
      expect(screen.getByText('Install: PHP')).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText(/step 2/)).not.toBeNull();
      expect(screen.getByText(/done \(exit 0\)/)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows start failures inline', async () => {
    stubApi((url) =>
      url === '/api/install'
        ? { status: 200, json: ITEMS }
        : { status: 400, json: { error: 'Installation already running' } },
    );
    await act(async () => {
      render(<StorePage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Install'));
    });
    expect(screen.getByRole('alert').textContent).toBe('Installation already running');
    expect(screen.queryByText('Install: PHP')).toBeNull();
  });

  it('closes the modal and stops polling', async () => {
    vi.useFakeTimers();
    try {
      let logCalls = 0;
      stubApi((url) => {
        if (url === '/api/install') return { status: 200, json: ITEMS };
        if (url.endsWith('/start')) return { status: 200, json: { ok: true } };
        logCalls++;
        return { status: 200, json: { logs: 'working\n', running: true, exitCode: null } };
      });
      await act(async () => {
        render(<StorePage />);
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Install'));
      });
      const before = logCalls;
      await act(async () => {
        fireEvent.click(screen.getByText('Close'));
      });
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(logCalls).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
