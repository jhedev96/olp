// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
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

/** Single messy-JS-file workspace (prettify/diff tests). */
function jsHandler(url: string, body: unknown): { status: number; json: unknown } {
  if (url.startsWith('/api/files?path=')) {
    return { status: 200, json: { path: '', entries: [{ name: 'm.js', type: 'file', size: 9, mtime: 0 }] } };
  }
  if (url === '/api/read') {
    const name = (body as { name?: unknown }).name;
    if (name === 'm.js') return { status: 200, json: { ok: true, content: 'const x=1' } };
    return { status: 200, json: { ok: true, content: 'hello' } };
  }
  return { status: 200, json: { ok: true } };
}

async function openFirstEditor(): Promise<{ view: EditorView | null }> {
  const holder: { view: EditorView | null } = { view: null };
  await act(async () => {
    render(<FilesPage editorViewRef={(v) => { holder.view = v; }} />);
  });
  await act(async () => {
    fireEvent.click(screen.getAllByText('Edit')[0] as HTMLElement);
  });
  return holder;
}

describe('web files page', () => {
  it('lists entries with per-type actions', async () => {    stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    expect(screen.getByText('docs')).not.toBeNull();
    expect(screen.getByText('a.txt')).not.toBeNull();
    expect(screen.getAllByText('Zip')).toHaveLength(4);
    expect(screen.getAllByText('View')).toHaveLength(2);
    expect(screen.getByText('Unzip')).not.toBeNull();
    expect(screen.getByText('11 B')).not.toBeNull();
  });

  it('honors the ?path= deep-link on mount', async () => {
    const { calls } = stubApi(filesHandler);
    window.history.pushState({}, '', '/files?path=docs');
    try {
      await act(async () => {
        render(<FilesPage />);
      });
      expect(calls.some((c) => c.url === '/api/files?path=docs')).toBe(true);
    } finally {
      window.history.pushState({}, '', '/files');
    }
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
    const holder: { view: EditorView | null } = { view: null };
    await act(async () => {
      render(<FilesPage editorViewRef={(v) => { holder.view = v; }} />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[0] as HTMLElement);
    });
    expect(holder.view).not.toBeNull();
    expect(document.querySelector('.cm-editor')).not.toBeNull();
    expect(document.querySelector('.cm-content')?.textContent).toContain('hello');
    await act(async () => {
      const doc = holder.view?.state.doc;
      holder.view?.dispatch({ changes: { from: 0, to: doc?.length ?? 0, insert: 'world' } });
    });
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
    const holder: { view: EditorView | null } = { view: null };
    await act(async () => {
      render(<FilesPage editorViewRef={(v) => { holder.view = v; }} />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[0] as HTMLElement);
    });
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('a.txt');
    expect(document.querySelector('.cm-content')?.textContent).toContain('hello');
    await act(async () => {
      const doc = holder.view?.state.doc;
      holder.view?.dispatch({ changes: { from: 0, to: doc?.length ?? 0, insert: 'world' } });
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[1] as HTMLElement);
    });
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('a.zip');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Close a.zip'));
    });
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('a.txt');
    expect(document.querySelector('.cm-content')?.textContent).toContain('world');
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
    expect(screen.getByText('Storage mounts')).not.toBeNull();
  });

  it('shows bulk size, refreshes and discards edits', async () => {
    const { calls } = stubApi(filesHandler);
    const holder: { view: EditorView | null } = { view: null };
    await act(async () => {
      render(<FilesPage editorViewRef={(v) => { holder.view = v; }} />);
    });
    fireEvent.click(screen.getByLabelText('Select a.txt'));
    expect(screen.getByText('Total size: 11 B')).not.toBeNull();
    const before = calls.filter((c) => c.url.startsWith('/api/files?path=')).length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });
    expect(calls.filter((c) => c.url.startsWith('/api/files?path=')).length).toBe(before + 1);
    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[0] as HTMLElement);
    });
    expect(screen.getByText('UTF-8 · LF · 1 lines')).not.toBeNull();
    await act(async () => {
      const doc = holder.view?.state.doc;
      holder.view?.dispatch({ changes: { from: 0, to: doc?.length ?? 0, insert: 'dirty' } });
    });
    expect(screen.getByText('UTF-8 · LF · 1 lines · edited')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    });
    expect(document.querySelector('.cm-content')?.textContent).toContain('hello');
  });

  it('previews text as plain pre and images by url', async () => {
    stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('View')[0] as HTMLElement);
    });
    expect(screen.getByText('hello')).not.toBeNull();
    expect(document.querySelector('span[class*="hljs-"]')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Close'));
    });
    expect(screen.queryByText('hello')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getAllByText('View')[1] as HTMLElement);
    });
    const img = document.querySelector('img[alt="i.png"]') as HTMLImageElement;
    expect(img.src).toContain('/api/files/preview');
  });

  it('prettifies the active tab in place', async () => {
    stubApi(jsHandler);
    const holder = await openFirstEditor();
    expect(document.querySelector('.cm-content')?.textContent).toContain('const x=1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prettify' }));
    });
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toContain('const x = 1;');
    });
    expect(holder.view?.state.doc.toString()).toBe('const x = 1;\n');
  });

  it('keeps content with an inline error on syntax failure', async () => {
    stubApi(jsHandler);
    const holder = await openFirstEditor();
    await act(async () => {
      const doc = holder.view?.state.doc;
      holder.view?.dispatch({ changes: { from: 0, to: doc?.length ?? 0, insert: 'const =' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prettify' }));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Prettify failed/);
    });
    expect(holder.view?.state.doc.toString()).toBe('const =');
  });

  it('shows diff hunks and clears them after discard', async () => {
    stubApi(jsHandler);
    const holder = await openFirstEditor();
    await act(async () => {
      const doc = holder.view?.state.doc;
      holder.view?.dispatch({ changes: { from: 0, to: doc?.length ?? 0, insert: 'const x = 2;' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
    });
    expect(screen.getByLabelText('Unsaved changes in m.js')).not.toBeNull();
    expect(screen.getByText('@@ -1,1 +1,1 @@')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    });
    expect(screen.getByText('No unsaved changes.')).not.toBeNull();
  });

  it('disables prettify for unsupported languages', async () => {
    stubApi(filesHandler);
    await openFirstEditor();
    const button = screen.getByRole('button', { name: 'Prettify' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('title')).toBe('Prettier has no txt parser here');
  });

  it('docks the editor beside the list instead of a modal', async () => {
    stubApi(filesHandler);
    await openFirstEditor();
    expect(document.querySelector('.fixed.inset-0')).toBeNull();
    expect(screen.getByLabelText('Code panel')).not.toBeNull();
    expect(screen.getByText('docs')).not.toBeNull();
    expect(screen.getAllByText('a.txt')).toHaveLength(2);
    expect(document.querySelector('.cm-editor')).not.toBeNull();
  });

  it('closes the panel with Escape', async () => {
    stubApi(filesHandler);
    await openFirstEditor();
    expect(screen.getByLabelText('Code panel')).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByLabelText('Code panel')).toBeNull();
  });

  it('toggles between editor and preview in one panel', async () => {
    stubApi(filesHandler);
    await act(async () => {
      render(<FilesPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[0] as HTMLElement);
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText('View')[0] as HTMLElement);
    });
    expect(screen.getByRole('button', { name: 'Editor' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Preview' })).not.toBeNull();
    expect(document.querySelector('.cm-editor')).toBeNull();
    expect(screen.getByText('hello')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Editor' }));
    });
    expect(document.querySelector('.cm-editor')).not.toBeNull();
  });

  it('shows modes, chmods through a dialog, and lists mounts', async () => {
    const { calls } = stubApi((url, body) => {
      if (url.startsWith('/api/files?path=')) {
        return {
          status: 200,
          json: {
            path: '',
            entries: [
              { name: 'docs', type: 'dir', size: 0, mtime: 0, mode: '0755' },
              { name: 'a.txt', type: 'file', size: 11, mtime: 0, mode: '0644' },
            ],
          },
        };
      }
      if (url === '/api/mounts') {
        return { status: 200, json: { mounts: [{ path: '/r', present: true, dir: true }, { path: '/nope', present: false, dir: false }] } };
      }
      if (url === '/api/chmod') return { status: 200, json: { ok: true } };
      return filesHandler(url, body);
    });
    await act(async () => {
      render(<FilesPage />);
    });
    expect(screen.getByText('0755')).not.toBeNull();
    expect(screen.getByText('0644')).not.toBeNull();
    expect(screen.getByText('/r')).not.toBeNull();
    expect(screen.getByText('present')).not.toBeNull();
    expect(screen.getByText('absent')).not.toBeNull();
    expect(screen.queryByText('Storage mounts & shortcuts')).toBeNull();
    const row = (screen.getByText('0644').closest('tr') as HTMLElement) ?? document.body;
    await act(async () => {
      fireEvent.click(within(row).getByText('Chmod'));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('a.txt');
    fireEvent.change(within(dialog).getByPlaceholderText('0644'), { target: { value: '0600' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Chmod' }));
    });
    expect(calls.find((c) => c.url === '/api/chmod')?.body).toEqual({ path: '', name: 'a.txt', mode: '0600' });
  });
});
