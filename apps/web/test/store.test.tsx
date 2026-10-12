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
    { id: 'nginx', name: 'Nginx', desc: 'Web server', conf: '$PREFIX/etc/nginx/nginx.conf', installed: true, installing: false },
    { id: 'php', name: 'PHP', desc: '', conf: null, installed: false, installing: false },
  ],
};

const VERSIONS = { versions: { nginx: 'nginx/1.24.0', php: null } };
const MIRROR = { manager: 'apt', mirror: null, latencyMs: null };

function fullHandler(url: string): { status: number; json: unknown } {
  if (url === '/api/install/versions') return { status: 200, json: VERSIONS };
  if (url === '/api/install/mirror') return { status: 200, json: MIRROR };
  if (url === '/api/stats') return { status: 200, json: {} };
  return { status: 200, json: ITEMS };
}

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

  it('shows versions, conf and the mirror card', async () => {
    stubApi((url) => fullHandler(url));
    await act(async () => {
      render(<StorePage />);
    });
    expect(screen.getByText('nginx/1.24.0')).not.toBeNull();
    expect(screen.getByText('Conf: $PREFIX/etc/nginx/nginx.conf')).not.toBeNull();
    expect(screen.getByText('Configure')).not.toBeNull();
    expect(screen.queryByText('CAND-027')).toBeNull();
    expect(screen.getByText('Mirror & latency')).not.toBeNull();
    expect(screen.getByText('APT')).not.toBeNull();
  });

  it('runs repo update in the shared log modal', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      stubApi((url) => {
        if (url === '/api/install/update/start') return { status: 200, json: { ok: true } };
        if (url === '/api/install/update/log') {
          polls++;
          return polls < 2
            ? { status: 200, json: { logs: 'Hit:1ports\n', running: true, exitCode: null } }
            : { status: 200, json: { logs: 'Hit:1ports\nDone\n', running: false, exitCode: 0 } };
        }
        return fullHandler(url);
      });
      await act(async () => {
        render(<StorePage />);
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update repo'));
      });
      expect(screen.getByText('Repo update')).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText(/Done/)).not.toBeNull();
      expect(screen.getByText(/done \(exit 0\)/)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('navigates Configure to files with the conf path', async () => {
    stubApi((url) => fullHandler(url));
    await act(async () => {
      render(<StorePage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Configure'));
    });
    expect(window.location.pathname).toBe('/files');
    expect(window.location.search).toContain('path=');
    expect(decodeURIComponent(window.location.search)).toContain('$PREFIX/etc/nginx/nginx.conf');
    window.history.pushState({}, '', '/store');
  });

  it('filters to installed only', async () => {
    stubApi((url) => fullHandler(url));
    await act(async () => {
      render(<StorePage />);
    });
    expect(screen.getByText('PHP')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Installed only'));
    expect(screen.queryByText('PHP')).toBeNull();
    expect(screen.getByText('Nginx')).not.toBeNull();
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

  it('searches, categorizes and sorts packages', async () => {
    stubApi(() => ({ status: 200, json: ITEMS }));
    await act(async () => {
      render(<StorePage />);
    });
    expect(screen.getByText('1 installed / 2 total')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Update repo' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Batch upgrade' })).toHaveProperty('disabled', false);
    expect(screen.queryByText('CAND-027')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search packages'), { target: { value: 'ngin' } });
    expect(screen.queryByText('PHP')).toBeNull();
    expect(screen.getByText('Nginx')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Search packages'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Runtimes & Langs (1)' }));
    });
    expect(screen.queryByText('Nginx')).toBeNull();
    expect(screen.getByText('PHP')).not.toBeNull();
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
