// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BackupPage } from '../src/pages/backup.js';

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

const BACKUPS = {
  backups: [
    { name: 'b1', file: 'b1.zip', type: 'folder', source: 'proj', size: 2048, mtime: 0, created: 2000 },
    { name: 'm1', file: 'm1.sql', type: 'mysql', source: 'appdb', size: 100, mtime: 0, created: 1000 },
  ],
};

describe('web backup page', () => {
  it('lists newest-first with sizes', async () => {
    stubApi(() => ({ status: 200, json: BACKUPS }));
    await act(async () => {
      render(<BackupPage />);
    });
    const rows = screen.getAllByRole('row');
    expect(rows[0]?.textContent).toContain('b1');
    expect(rows[1]?.textContent).toContain('m1');
    expect(screen.getByText('2.0 KB')).not.toBeNull();
  });

  it('creates with the form payload', async () => {
    const { calls } = stubApi((url) =>
      url === '/api/backups' ? { status: 200, json: { backups: [] } } : { status: 200, json: { ok: true, name: 'b2' } },
    );
    await act(async () => {
      render(<BackupPage />);
    });
    fireEvent.change(screen.getByPlaceholderText('Backup name (optional)'), { target: { value: 'b2' } });
    fireEvent.change(screen.getByPlaceholderText('Folder path (empty = root)'), { target: { value: 'proj' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Create backup'));
    });
    const save = calls.find((c) => c.method === 'POST');
    expect(save?.url).toBe('/api/backups');
    expect(save?.body).toMatchObject({ name: 'b2', type: 'folder', source: 'proj' });
  });

  it('shows create errors', async () => {
    stubApi(() => ({ status: 400, json: { error: 'Backup name already taken' } }));
    await act(async () => {
      render(<BackupPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Create backup'));
    });
    expect(screen.getByRole('alert').textContent).toBe('Backup name already taken');
  });

  it('restores and deletes with confirms', async () => {
    const { calls } = stubApi(() => ({ status: 200, json: BACKUPS }));
    (window as unknown as Record<string, unknown>).confirm = () => true;
    await act(async () => {
      render(<BackupPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Restore')[0] as HTMLElement);
    });
    const restore = calls.find((c) => c.url === '/api/backups/b1/restore');
    expect(restore?.method).toBe('POST');
    expect(restore?.body).toEqual({});
    await act(async () => {
      fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    });
    expect(calls.some((c) => c.url === '/api/backups/b1' && c.method === 'DELETE')).toBe(true);
  });

  it('links downloads per backup', async () => {
    stubApi(() => ({ status: 200, json: BACKUPS }));
    await act(async () => {
      render(<BackupPage />);
    });
    const links = screen.getAllByText('Download');
    expect(links).toHaveLength(2);
    expect((links[0] as HTMLAnchorElement).href).toContain('/api/backups/b1/download');
  });
});
