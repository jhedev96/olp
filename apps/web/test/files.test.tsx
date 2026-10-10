// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FilesPage } from '../src/pages/files.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

interface Recorded {
  url: string;
  body: unknown;
}

const ROOT_ENTRIES = [
  { name: 'docs', type: 'dir', size: 0, mtime: 1728470400000 },
  { name: 'a.txt', type: 'file', size: 11, mtime: 1728470400000 },
  { name: 'i.png', type: 'file', size: 8, mtime: 1728470400000 },
  { name: 'a.zip', type: 'file', size: 100, mtime: 1728470400000 },
];

function stubApi(handler: (url: string, body: unknown) => { status: number; json: unknown }): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const body = init?.body !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const { status, json } = handler(url, body);
    return Promise.resolve(new Response(JSON.stringify(json), { status }));
  });
  return { calls };
}

function filesHandler(url: string, body: unknown): { status: number; json: unknown } {
  if (url.startsWith('/api/files?path=')) {
    const path = decodeURIComponent(url.split('path=')[1] ?? '');
    if (path === 'docs') return { status: 200, json: { path, entries: [{ name: 'n.txt', type: 'file', size: 1, mtime: 0 }] } };
    return { status: 200, json: { path: '', entries: ROOT_ENTRIES } };
  }
  if (url === '/api/read') return { status: 200, json: { ok: true, content: 'hello' } };
  if (url === '/api/upload') return { status: 200, json: { ok: true, size: 5 } };
  return { status: 200, json: { ok: true } };
}

describe('web files page', () => {
  it('lists entries with per-type actions', async () => {
    stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    expect(screen.getByText('docs')).not.toBeNull();
    expect(screen.getByText('a.txt')).not.toBeNull();
    expect(screen.getAllByText('Zip')).toHaveLength(4);
    expect(screen.getByText('View')).not.toBeNull();
    expect(screen.getByText('Unzip')).not.toBeNull();
    expect(screen.getByText('11 B')).not.toBeNull();
  });

  it('navigates into directories and back up', async () => {
    stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('docs'));
    });
    expect(screen.getByText('n.txt')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('..'));
    });
    expect(screen.getByText('a.txt')).not.toBeNull();
  });

  it('creates folders from the input field', async () => {
    const { calls } = stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    fireEvent.change(screen.getByPlaceholderText('New folder / file name'), { target: { value: 'ndir' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Mkdir'));
    });
    expect(calls.some((c) => c.url === '/api/mkdir' && (c.body as { name: string }).name === 'ndir')).toBe(true);
  });

  it('confirms deletes and prompts renames via dialog', async () => {
    const { calls } = stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    });
    const delDialog = screen.getByRole('dialog');
    expect(delDialog.textContent).toContain('This cannot be undone.');
    await act(async () => {
      fireEvent.click(within(delDialog).getByRole('button', { name: 'Delete' }));
    });
    expect(calls.some((c) => c.url === '/api/delete')).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getAllByText('Rename')[0] as HTMLElement);
    });
    const renameDialog = screen.getByRole('dialog');
    const input = within(renameDialog).getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('a.txt');
    fireEvent.change(input, { target: { value: 'b.txt' } });
    await act(async () => {
      fireEvent.click(within(renameDialog).getByRole('button', { name: 'Rename' }));
    });
    expect(calls.some((c) => c.url === '/api/rename' && (c.body as { to: string }).to === 'b.txt')).toBe(true);

    fireEvent.click(screen.getByText('Touch'));
    const touchDialog = screen.getByRole('dialog');
    fireEvent.change(within(touchDialog).getByRole('textbox'), { target: { value: 'n.txt' } });
    await act(async () => {
      fireEvent.click(within(touchDialog).getByRole('button', { name: 'Create' }));
    });
    expect(calls.some((c) => c.url === '/api/touch' && (c.body as { name: string }).name === 'n.txt')).toBe(true);
  });

  it('opens the editor and saves', async () => {
    const { calls } = stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[0] as HTMLElement);
    });
    const area = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(area.value).toBe('hello');
    fireEvent.change(area, { target: { value: 'world' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    const write = calls.find((c) => c.url === '/api/write');
    expect(write?.body).toMatchObject({ name: 'a.txt', content: 'world' });
  });

  it('uploads files as base64', async () => {
    const { calls } = stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    const file = new File(['hello'], 'u.bin', { type: 'application/octet-stream' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/upload')).toBe(true);
    });
    const upload = calls.find((c) => c.url === '/api/upload');
    expect(upload?.body).toMatchObject({ name: 'u.bin', data: Buffer.from('hello').toString('base64') });
  });

  it('shows load errors', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('down')));
    await act(async () => {
      render(<FilesPage />);
    });
    expect(screen.getByRole('alert').textContent).toBe('Failed to load');
  });

  it('edits files in tabs and closes them', async () => {
    stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[0] as HTMLElement);
    });
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('a.txt');
    const area = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(area.value).toBe('hello');
    fireEvent.change(area, { target: { value: 'world' } });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[1] as HTMLElement);
    });
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('a.zip');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Close a.zip'));
    });
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('a.txt');
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('world');
  });

  it('selects entries and deletes them in bulk', async () => {
    const { calls } = stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    fireEvent.click(screen.getByLabelText('Select a.txt'));
    fireEvent.click(screen.getByLabelText('Select i.png'));
    expect(screen.getByText('2')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
    });
    const dialog = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 2' }));
    });
    expect(calls.filter((c) => c.url === '/api/delete')).toHaveLength(2);
  });

  it('searches, sorts and counts entries', async () => {
    stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    expect(screen.getByText('4 items (1 folders, 3 files)')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: '.zip' } });
    expect(screen.queryByText('a.txt')).toBeNull();
    expect(screen.getByText('a.zip')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Sort entries'), { target: { value: 'size' } });
    expect(screen.getByText('CAND-019')).not.toBeNull();
  });
});
