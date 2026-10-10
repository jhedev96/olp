// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DatabasePage } from '../src/pages/database.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

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
  if (url.endsWith('/config')) return { status: 200, json: { config: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '' }, connected: false } };
  if (url.endsWith('/test')) return { status: 200, json: { ok: true } };
  if (url.endsWith('/connect')) return { status: 200, json: { ok: true, databases: ['appdb'] } };
  if (url.endsWith('/databases')) return { status: 200, json: { databases: ['appdb'] } };
  if (url.includes('/tables?')) return { status: 200, json: { tables: ['users'] } };
  if (url.includes('/rows?')) return { status: 200, json: { fields: ['id', 'name'], rows: [{ id: 1, name: 'ops' }, { id: 2, name: null }] } };
  if (url.endsWith('/query')) return { status: 200, json: { fields: ['n'], rows: [{ n: 2 }], affected: 1 } };
  return { status: 200, json: { ok: true } };
}

describe('web database page', () => {
  it('loads config and stays disconnected', async () => {
    stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<DatabasePage />);
    });
    expect(screen.getByText('Not connected')).not.toBeNull();
    expect((screen.getByPlaceholderText('Host (127.0.0.1)') as HTMLInputElement).value).toBe('127.0.0.1');
    expect(screen.queryByText('Databases')).toBeNull();
  });

  it('tests connections with inline messages', async () => {
    stubApi((url) => (url.endsWith('/test') ? { status: 200, json: { ok: false, error: 'denied' } } : baseHandler(url)));
    await act(async () => {
      render(<DatabasePage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Test Connection'));
    });
    expect(screen.getByText('Failed: denied')).not.toBeNull();
  });

  it('connects, browses, and disconnects', async () => {
    const { calls } = stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<DatabasePage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save & Connect'));
    });
    expect(screen.getByText('Connected (mysql)')).not.toBeNull();
    expect(screen.getByText('appdb')).not.toBeNull();
    const connect = calls.find((c) => c.url.endsWith('/connect'));
    expect(connect?.body).toMatchObject({ host: '127.0.0.1', user: 'root' });

    await act(async () => {
      fireEvent.click(screen.getByText('appdb'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('users'));
    });
    expect(screen.getByText('ops')).not.toBeNull();
    expect(screen.getByText('NULL')).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText('Disconnect'));
    });
    expect(screen.getByText('Not connected')).not.toBeNull();
    expect(screen.queryByText('Databases')).toBeNull();
  });

  it('runs SQL with affected line and empty states', async () => {
    stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<DatabasePage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save & Connect'));
    });
    const area = screen.getByPlaceholderText('SELECT * FROM users LIMIT 10') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: 'SELECT 1' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Run'));
    });
    expect(screen.getByText('1 rows affected')).not.toBeNull();
  });

  it('switches engines and reloads config', async () => {
    const { calls } = stubApi((url, _method, _body) => {
      if (url.includes('/postgres/config')) {
        return { status: 200, json: { config: { host: 'pg.local', port: 5432, user: 'pg', password: '', database: '' }, connected: false } };
      }
      return baseHandler(url);
    });
    await act(async () => {
      render(<DatabasePage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('PostgreSQL'));
    });
    expect((screen.getByPlaceholderText('Host (127.0.0.1)') as HTMLInputElement).value).toBe('pg.local');
    expect(calls.some((c) => c.url === '/api/db/postgres/config')).toBe(true);
  });
});
