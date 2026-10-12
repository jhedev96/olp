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
  if (url.includes('/schema?')) {
    return { status: 200, json: { tables: [{ name: 'users', rows: 12, dataBytes: 16384, indexBytes: 4096 }] } };
  }
  if (url.includes('/ddl?')) {
    return { status: 200, json: { ddl: 'CREATE TABLE `users` (`id` int)', columns: null } };
  }
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

  it('shows the live version and runs on Ctrl+Enter', async () => {
    stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<DatabasePage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save & Connect'));
    });
    expect(await screen.findByText('2')).not.toBeNull();
    const area = screen.getByPlaceholderText('SELECT * FROM users LIMIT 10') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: 'SELECT 1' } });
    await act(async () => {
      fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
    });
    expect(screen.getByText('1 rows affected')).not.toBeNull();
  });

  it('parks unfinished engines and transfers, ships New Database', async () => {
    stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<DatabasePage />);
    });
    expect(screen.getByRole('button', { name: 'Redis' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'New Database' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Export' })).toHaveProperty('disabled', true);
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

  it('clears SQL, filters tables and shows the connection string', async () => {
    stubApi((url) => baseHandler(url));
    await act(async () => {
      render(<DatabasePage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save & Connect'));
    });
    expect(screen.getByText('Databases (1)')).not.toBeNull();
    expect(screen.getByText(/mysql -u root/)).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Filter tables'), { target: { value: 'zzz' } });
    await act(async () => {
      fireEvent.click(screen.getByText('appdb'));
    });
    expect(screen.queryByText('users')).toBeNull();
    const area = screen.getByPlaceholderText('SELECT * FROM users LIMIT 10') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: 'SELECT 1' } });
    fireEvent.click(screen.getByText('Clear'));
    expect((screen.getByPlaceholderText('SELECT * FROM users LIMIT 10') as HTMLTextAreaElement).value).toBe('');
  });

  it('creates databases, badges schema sizes and shows DDL', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      let json: unknown;
      if (url.endsWith('/databases') && (init?.method ?? 'GET') === 'POST') {
        json = { ok: true, databases: ['appdb', 'newdb'] };
      } else {
        json = baseHandler(url).json;
      }
      return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));
    });
    await act(async () => {
      render(<DatabasePage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save & Connect'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('New Database'));
    });
    const input = screen.getByPlaceholderText('Database name (letters, digits, _ and $)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'newdb' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    });
    expect(calls).toContainEqual({ url: '/api/db/mysql/databases', method: 'POST' });
    expect(screen.getByText('Databases (2)')).not.toBeNull();
    expect(screen.getByText(/"newdb" created/)).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('appdb'));
    });
    expect(screen.getByText(/12 rows/)).not.toBeNull();
    expect(screen.getByText(/16\.0 KB data/)).not.toBeNull();
    expect(screen.getByText(/4\.0 KB/)).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Schema'));
    });
    expect(screen.getByText(/CREATE TABLE `users`/)).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Close'));
    });
    expect(screen.queryByText(/CREATE TABLE `users`/)).toBeNull();
  });
});
