// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    expect(rows[1]?.textContent).toContain('b1');
    expect(rows[2]?.textContent).toContain('m1');
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

  it('shows stats, engines and schedules section', async () => {
    stubApi((url) => {
      if (url === '/api/stats') return { status: 200, json: { disk: { free: 82800000000 } } };
      if (url === '/api/install') {
        return { status: 200, json: { items: [{ id: 'zip', installed: true }, { id: 'mysql', installed: false }] } };
      }
      if (url === '/api/backups/schedules') return { status: 200, json: { schedules: [] } };
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
    expect(screen.getByText('Scheduled snapshots')).not.toBeNull();
    expect(screen.getByText('No schedules yet — snapshots run while the panel is up.')).not.toBeNull();
    expect(screen.queryByText('CAND-029')).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter snapshots'), { target: { value: 'm1' } });
    expect(screen.queryByText('b1')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /mysql \(\d+\)/ }));
    });
    expect(screen.queryByText('b1')).toBeNull();
    expect(screen.getByText('m1')).not.toBeNull();
  });

  it('verifies archives, uploads and manages schedules', async () => {    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = init?.body !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body });
      let json: unknown = BACKUPS;
      if (url.endsWith('/verify')) json = { ok: true, sha256: 'ab'.repeat(32), match: true };
      if (url === '/api/backups/upload') json = { ok: true, name: 'up1' };
      if (url === '/api/backups/schedules' && (init?.method ?? 'GET') === 'GET') {
        json = { schedules: [{ id: 's1', name: 'night', type: 'folder', source: 'proj', schedule: '0 2 * * *', enabled: true, created: 1, lastRun: 2, lastStatus: 'ok', nextRun: 3 }] };
      }
      if (url === '/api/backups/schedules' && init?.method === 'POST') json = { ok: true, schedule: { id: 's1' } };
      if (url === '/api/stats') json = {};
      if (url === '/api/install') json = { items: [] };
      return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));
    });
    await act(async () => {
      render(<BackupPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Verify')[0] as HTMLElement);
    });
    expect(screen.getByText('SHA256 OK')).not.toBeNull();
    expect(calls.some((c) => c.url === '/api/backups/b1/verify')).toBe(true);
    const file = new File(['hello'], 'up.zip', { type: 'application/zip' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/backups/upload')).toBe(true);
    });
    expect(screen.getByText('night')).not.toBeNull();
    expect(screen.getByText(/last /)).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Folder path or database'), { target: { value: 'proj' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Add schedule'));
    });
    expect(calls.some((c) => c.url === '/api/backups/schedules' && c.method === 'POST')).toBe(true);
  });

  it('snapshots full systems from a checklist dialog', async () => {
    const { calls } = stubApi((url, method) => {
      if (url === '/api/db/mysql/databases') return { status: 200, json: { databases: ['appdb', 'blog'] } };
      if (url === '/api/db/postgres/databases') return { status: 400, json: { error: 'Not connected' } };
      if (url === '/api/bundles' && method === 'GET') return { status: 200, json: { bundles: [] } };
      if (url === '/api/bundles' && method === 'POST') return { status: 200, json: { ok: true, id: 'bundle-1' } };
      if (url === '/api/bundles/bundle-1') {
        return {
          status: 200,
          json: {
            bundle: null,
            job: { id: 'bundle-1', state: 'done', steps: [{ key: 'enumerate', label: 'Discover databases', status: 'ok', detail: 'mysql: 1' }], started: 1, finished: 2 },
          },
        };
      }
      if (url === '/api/stats') return { status: 200, json: {} };
      if (url === '/api/install') return { status: 200, json: { items: [] } };
      if (url === '/api/backups/schedules') return { status: 200, json: { schedules: [] } };
      return { status: 200, json: BACKUPS };
    });
    await act(async () => {
      render(<BackupPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Start full snapshot'));
    });
    const bundleDialog = screen.getByRole('dialog');
    await waitFor(() => {
      expect(within(bundleDialog).getByText('appdb')).not.toBeNull();
    });
    expect(within(bundleDialog).getByText('blog')).not.toBeNull();
    expect(within(bundleDialog).getByText(/Not connected/)).not.toBeNull();
    const boxes = within(bundleDialog).getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    fireEvent.click(boxes[1] as HTMLElement);
    await act(async () => {
      fireEvent.click(within(bundleDialog).getByText('Start snapshot'));
    });
    const post = calls.find((c) => c.url === '/api/bundles' && c.method === 'POST');
    expect(post?.body).toEqual({ databases: { mysql: ['appdb'], postgres: [] }, configs: true, crons: true });
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/bundles/bundle-1')).toBe(true);
    });
  });

  it('restore-alls behind a danger dialog with live steps', async () => {
    const bundle = {
      id: 'bundle-9',
      created: 5,
      parts: [
        { name: 'bundle-9--mysql-appdb', file: 'bundle-9--mysql-appdb.sql.gz', kind: 'mysql', sha256: 'a' },
        { name: 'bundle-9--configs', file: 'bundle-9--configs.zip', kind: 'configs', sha256: 'b' },
      ],
    };
    const { calls } = stubApi((url, method) => {
      if (url === '/api/bundles' && method === 'GET') return { status: 200, json: { bundles: [bundle] } };
      if (url === '/api/bundles/bundle-9/restore') return { status: 200, json: { ok: true, id: 'restore-1' } };
      if (url === '/api/bundles/restores/restore-1') {
        return {
          status: 200,
          json: {
            job: {
              id: 'restore-1',
              state: 'done',
              steps: [{ key: 'restore-configs', label: 'Restore configs', status: 'ok', detail: '1 files applied' }],
              started: 1,
              finished: 2,
            },
          },
        };
      }
      if (url.endsWith('/verify')) return { status: 200, json: { ok: true, sha256: 'ab'.repeat(32), match: true } };
      if (url === '/api/stats') return { status: 200, json: {} };
      if (url === '/api/install') return { status: 200, json: { items: [] } };
      if (url === '/api/backups/schedules') return { status: 200, json: { schedules: [] } };
      return { status: 200, json: BACKUPS };
    });
    await act(async () => {
      render(<BackupPage />);
    });
    expect(screen.getByText('bundle-9')).not.toBeNull();
    expect(screen.getByText(/1 db/)).not.toBeNull();
    const item = (screen.getByText('bundle-9').closest('li') as HTMLElement) ?? document.body;
    await act(async () => {
      fireEvent.click(within(item).getByText('Restore all'));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('drops and recreates');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restore all' }));
    });
    expect(calls.some((c) => c.url === '/api/bundles/bundle-9/restore' && c.method === 'POST')).toBe(true);
    expect(calls.find((c) => c.url === '/api/bundles/bundle-9/restore')?.body).toEqual({});
    await waitFor(() => {
      expect(screen.getByText(/1 files applied/)).not.toBeNull();
    });
    expect(screen.getByText('Dismiss')).not.toBeNull();
    // Per-part reuse: download link, verify badge, single-part restore dialog.
    const downloads = within(item).getAllByText('Download');
    expect(downloads.map((d) => (d as HTMLAnchorElement).getAttribute('href'))).toContain('/api/backups/bundle-9--configs/download');
    await act(async () => {
      fireEvent.click(within(item).getAllByText('Verify')[0] as HTMLElement);
    });
    expect(within(item).getByText('SHA256 OK')).not.toBeNull();
    await act(async () => {
      fireEvent.click(within(item).getByText('Restore'));
    });
    expect(screen.getByRole('dialog').textContent).toContain('may be overwritten');
  });

  it('asks the current password for auth bundles and handles logout', async () => {
    const bundle = { id: 'bundle-auth', created: 7, hasAuth: true, parts: [] };
    const { calls } = stubApi((url, method) => {
      if (url === '/api/bundles' && method === 'GET') return { status: 200, json: { bundles: [bundle] } };
      if (url === '/api/bundles/bundle-auth/restore') return { status: 200, json: { ok: true, id: 'restore-9' } };
      if (url === '/api/bundles/restores/restore-9') return { status: 401, json: { error: 'Not logged in' } };
      if (url === '/api/stats') return { status: 200, json: {} };
      if (url === '/api/install') return { status: 200, json: { items: [] } };
      if (url === '/api/backups/schedules') return { status: 200, json: { schedules: [] } };
      return { status: 200, json: BACKUPS };
    });
    await act(async () => {
      render(<BackupPage />);
    });
    const item = (screen.getByText('bundle-auth').closest('li') as HTMLElement) ?? document.body;
    await act(async () => {
      fireEvent.click(within(item).getByText('Restore all'));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('logged out');
    fireEvent.change(within(dialog).getByLabelText('Current password'), { target: { value: 'secret-pw' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Restore all' }));
    });
    expect(calls.find((c) => c.url === '/api/bundles/bundle-auth/restore')?.body).toEqual({ currentPassword: 'secret-pw' });
    await waitFor(() => {
      expect(screen.getByText(/restored credentials/)).not.toBeNull();
    });
    expect(screen.getByText('Go to login')).not.toBeNull();
    const polls = calls.filter((c) => c.url === '/api/bundles/restores/restore-9').length;
    expect(polls).toBeLessThan(3);
  });
});
