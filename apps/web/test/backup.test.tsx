// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

  it('restores and deletes with dialogs', async () => {
    const { calls } = stubApi(() => ({ status: 200, json: BACKUPS }));
    await act(async () => {
      render(<BackupPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Restore')[0] as HTMLElement);
    });
    const restoreDialog = screen.getByRole('dialog');
    expect(restoreDialog.textContent).toContain('may be overwritten');
    await act(async () => {
      fireEvent.click(within(restoreDialog).getByRole('button', { name: 'Restore' }));
    });
    const restore = calls.find((c) => c.url === '/api/backups/b1/restore');
    expect(restore?.method).toBe('POST');
    expect(restore?.body).toEqual({});
    await act(async () => {
      fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    });
    const delDialog = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.click(within(delDialog).getByRole('button', { name: 'Delete' }));
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

  it('shows stats, engines and the advanced dummy', async () => {
    stubApi((url) => {
      if (url === '/api/stats') return { status: 200, json: { disk: { free: 82800000000 } } };
      if (url === '/api/install') {
        return { status: 200, json: { items: [{ id: 'zip', installed: true }, { id: 'mysql', installed: false }] } };
      }
      return { status: 200, json: BACKUPS };
    });
    await act(async () => {
      render(<BackupPage />);
    });
    expect(screen.getByText('2 archives · 2.1 KB')).not.toBeNull();
    expect(screen.getByText('1 database dumps')).not.toBeNull();
    expect(screen.getByText('Directory zip: ready')).not.toBeNull();
    expect(screen.getByText('MySQL dump: missing')).not.toBeNull();
    expect(screen.getByText('Postgres snapshot: unknown')).not.toBeNull();
    expect(screen.getByText('CAND-029')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Filter snapshots'), { target: { value: 'm1' } });
    expect(screen.queryByText('b1')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /mysql \(\d+\)/ }));
    });
    expect(screen.queryByText('b1')).toBeNull();
    expect(screen.getByText('m1')).not.toBeNull();
  });
});
