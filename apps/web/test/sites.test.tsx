// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { SitesPage } from '../src/pages/sites.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

const SITES = {
  sites: [
    { id: 'a1', name: 'web', type: 'node', path: 'server.js', port: 3000, running: true },
    { id: 'b2', name: 'blog', type: 'php', path: 'blog/index.php', port: 4000, running: false },
  ],
};

function stubApi(handler: (url: string, method: string, body: unknown) => { status: number; json: unknown }): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const body = init?.body !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const { status, json } = handler(url, init?.method ?? 'GET', body);
    return Promise.resolve(new Response(JSON.stringify(json), { status }));
  });
  return { calls };
}

function baseHandler(url: string): { status: number; json: unknown } {
  if (url === '/api/sites') return { status: 200, json: SITES };
  if (url === '/api/nginx/status') return { status: 200, json: { running: true } };
  if (url === '/api/nginx/proxies') return { status: 200, json: { proxies: [] } };
  if (url.endsWith('/logs')) return { status: 200, json: { logs: 'out-1\n', running: true } };
  return { status: 200, json: { ok: true } };
}

describe('web sites page', () => {
  it('filters by type tab and shows actions', async () => {
    stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<SitesPage />);
    });
    expect(screen.getByText('web')).not.toBeNull();
    expect(screen.queryByText('blog')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('php'));
    });
    expect(screen.getByText('blog')).not.toBeNull();
    expect(screen.queryByText('web')).toBeNull();
    expect(screen.getByText('Stop')).not.toBeNull();
  });

  it('starts stops and deletes with reload', async () => {
    const { calls } = stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<SitesPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Stop')[0] as HTMLElement);
    });
    expect(calls.some((c) => c.url === '/api/sites/a1/stop' && c.method === 'POST')).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByText('Delete'));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Delete website "web"?');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(calls.some((c) => c.url === '/api/sites/a1/delete')).toBe(true);
  });

  it('adds sites with validation', async () => {
    const { calls } = stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<SitesPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Add (node)'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    expect(screen.getByText('Fill in all fields')).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Site name'), { target: { value: 'n' } });
    fireEvent.change(screen.getByPlaceholderText('Entry file or folder'), { target: { value: 's.js' } });
    fireEvent.change(screen.getByPlaceholderText('Port'), { target: { value: '5000' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    const save = calls.find((c) => c.url === '/api/sites' && c.method === 'POST');
    expect(save?.body).toMatchObject({ name: 'n', path: 's.js', port: 5000, type: 'node' });
  });

  it('shows logs in a modal', async () => {
    stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<SitesPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Log'));
    });
    expect(screen.getByText('Log: web')).not.toBeNull();
    expect(screen.getByText(/out-1/)).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Close'));
    });
    expect(screen.queryByText('Log: web')).toBeNull();
  });

  it('manages nginx service and proxies', async () => {
    const { calls } = stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<SitesPage />);
    });
    expect(screen.getByText('Nginx running')).not.toBeNull();
    expect(screen.getByText('No proxies yet')).not.toBeNull();
    const reloads = screen.getAllByText('Reload');
    await act(async () => {
      fireEvent.click(reloads[0] as HTMLElement);
    });
    expect(calls.some((c) => c.url === '/api/nginx/service')).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'p' } });
    fireEvent.change(screen.getByPlaceholderText('Listen port'), { target: { value: '8080' } });
    fireEvent.change(screen.getByPlaceholderText('Target port'), { target: { value: '3000' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Add proxy'));
    });
    const save = calls.find((c) => c.url === '/api/nginx/proxies' && c.method === 'POST');
    expect(save?.body).toMatchObject({ name: 'p', listenPort: 8080, domain: '', targetPort: 3000 });
  });

  it('searches, filters by status and counts', async () => {
    stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<SitesPage />);
    });
    expect(screen.getByText('1 online · 1 stopped · 0 proxies')).not.toBeNull();
    expect(screen.getByText('Open').getAttribute('href')).toContain(':3000');
    fireEvent.change(screen.getByLabelText('Search sites'), { target: { value: 'zzz' } });
    expect(screen.queryByText('web')).toBeNull();
    expect(screen.getByText('No node websites yet')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Search sites'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Filter status'), { target: { value: 'stopped' } });
    expect(screen.getByText('No node websites yet')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Filter status'), { target: { value: 'all' } });
    expect(screen.getByText('web')).not.toBeNull();
  });

  it('picks the engine from cards in the add modal', async () => {
    const { calls } = stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<SitesPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Add (node)'));
    });
    fireEvent.click(screen.getByLabelText('Engine go'));
    fireEvent.change(screen.getByPlaceholderText('Site name'), { target: { value: 'g' } });
    fireEvent.change(screen.getByPlaceholderText('Entry file or folder'), { target: { value: 'main.go' } });
    fireEvent.change(screen.getByPlaceholderText('Port'), { target: { value: '9090' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    const save = calls.find((c) => c.url === '/api/sites' && c.method === 'POST');
    expect(save?.body).toMatchObject({ name: 'g', path: 'main.go', port: 9090, type: 'go' });
  });
});
