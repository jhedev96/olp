import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Archive,
  ArrowUp,
  Download,
  Eye,
  File as FileIcon,
  Folder,
  PackageOpen,
  Pencil,
  PencilLine,
  Trash2,
  X,
  createIcons,
} from 'lucide';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtDate, fmtSize } from '../lib/format.js';
import type { EditorView } from '@codemirror/view';
import { ConfirmDialog, PromptDialog } from '../components/common/Dialog.js';
import { ComingSoon, EmptyState } from '../components/common/States.js';
import { CodeEditor } from '../components/code/CodeEditor.js';
import { CodePreview } from '../components/code/CodePreview.js';
import { languageFor } from '../components/code/languages.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** Tree-shaken icon set for this page (passed to `createIcons` per render). */
const ICONS = { Archive, ArrowUp, Download, Eye, File: FileIcon, Folder, PackageOpen, Pencil, PencilLine, Trash2, X };

function Icon({ name, label }: { name: string; label: string }): ReactElement {
  return (
    <span title={label} aria-hidden="true">
      <i data-lucide={name} className="inline h-4 w-4" />
    </span>
  );
}

/** `/api/files` entry shape (server contract). */
export interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
}

/** One open editor tab (client-side only — no backend). */
export interface EditorTab {
  name: string;
  content: string;
  /** Content as opened (Discard reverts here; Prettify/Diff need CAND-033). */
  original: string;
}

type SortKey = 'name' | 'size' | 'mtime';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|ico)$/i;

/** Read a browser File as base64 (upload path, Terwo FileReader parity). */
export function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function isImage(name: string): boolean {
  return IMAGE_RE.test(name);
}

function isZip(name: string): boolean {
  return /\.zip$/i.test(name);
}

/** Text-like names worth a read-only preview (dotfiles included). */
export function isPreviewable(name: string): boolean {
  if (isImage(name)) return false;
  if (languageFor(name).lowlight !== 'plaintext') return true;
  if (/\.(txt|log|conf|cfg|ini|toml)$/i.test(name)) return true;
  return /(^|\/)\.[^./]+$/.test(name);
}

/**
 * File manager (mockup file-manager parity): root card, search + sort
 * + refresh, multi-select bulk bar with selection size, tabbed code
 * editor (highlight + line numbers, discard-to-opened) and highlighted
 * read-only preview, per-type row actions, base64 upload, image
 * preview. The editor carries its native cursor (no custom readout).
 * Honestly omitted (no source,
 * backend frozen): Chmod column + ACL card (CAND-016), wakelock card,
 * CLI-jump chips (crumbs already cover fast navigation), symlink health
 * (CAND-014), editor prettify/diff (CAND-033); mounts/shortcuts ship as
 * a Coming-Soon section (CAND-019).
 */
export function FilesPage({ editorViewRef }: { editorViewRef?: (view: EditorView | null) => void } = {}): ReactElement {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState('');
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [editorError, setEditorError] = useState('');
  const [preview, setPreview] = useState<{ name: string; kind: 'image' | 'code'; content?: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [promptRename, setPromptRename] = useState<string | null>(null);
  const [promptTouch, setPromptTouch] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [diskFree, setDiskFree] = useState<number | null>(null);

  const load = useCallback(async (target: string): Promise<void> => {
    setError('');
    try {
      const body = await apiJson<{ path: string; entries: FileEntry[] }>(
        `/api/files?path=${encodeURIComponent(target)}`,
      );
      setDir(body.path);
      setEntries(body.entries);
      setSelected([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  useEffect(() => {
    let alive = true;
    void apiJson<{ disk?: { free?: unknown } }>('/api/stats', {}, { unauthorized: 'rethrow' })
      .then((body) => {
        if (alive && typeof body.disk?.free === 'number') setDiskFree(body.disk.free);
      })
      .catch(() => {
        // root card keeps its placeholder without disk numbers
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    createIcons({ icons: ICONS });
  });

  const up = (): void => {
    void load(dir.split('/').slice(0, -1).join('/'));
  };

  const runAction = async (endpoint: string, payload: Record<string, string>): Promise<void> => {
    setError('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir, ...payload }),
      });
      if (body.ok === true) await load(dir);
      else setError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const remove = (name: string): void => {
    setPendingDelete(name);
  };

  const confirmRemove = (): void => {
    if (pendingDelete === null) return;
    const name = pendingDelete;
    setPendingDelete(null);
    void runAction('/api/delete', { name });
  };

  const confirmBulkRemove = async (): Promise<void> => {
    const names = selected;
    setPendingBulkDelete(false);
    if (names.length === 0) return;
    setError('');
    setSelected([]);
    try {
      for (const name of names) {
        await apiJson('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir, name }),
        });
      }
      await load(dir);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const bulkZip = async (): Promise<void> => {
    const names = selected;
    if (names.length === 0) return;
    setError('');
    setSelected([]);
    try {
      for (const name of names) {
        await apiJson('/api/files/zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir === '' ? name : `${dir}/${name}` }),
        });
      }
      await load(dir);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const bulkDownload = (): void => {
    for (const name of selected) {
      const entry = entries.find((e) => e.name === name);
      if (entry === undefined || entry.type !== 'file') continue;
      const anchor = document.createElement('a');
      anchor.href = `/api/download?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`;
      anchor.click();
    }
  };

  const rename = (name: string): void => {
    setPromptRename(name);
  };

  const confirmRename = (next: string): void => {
    if (promptRename === null) return;
    const name = promptRename;
    setPromptRename(null);
    if (next === '' || next === name) return;
    void runAction('/api/rename', { from: name, to: next });
  };

  const confirmTouch = (name: string): void => {
    setPromptTouch(false);
    if (name !== '') void runAction('/api/touch', { name });
  };

  const openEditor = async (name: string): Promise<void> => {
    const existing = tabs.findIndex((t) => t.name === name);
    if (existing !== -1) {
      setActiveTab(existing);
      return;
    }
    setEditorError('');
    try {
      const body = await apiJson<{ ok?: unknown; content?: unknown; error?: string }>('/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir, name }),
      });
      if (typeof body.content === 'string') {
        setTabs((prev) => [...prev, { name, content: body.content as string, original: body.content as string }]);
        setActiveTab(tabs.length);
      } else setEditorError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setEditorError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const saveEditor = async (): Promise<void> => {
    const tab = tabs[activeTab];
    if (tab === undefined) return;
    setEditorError('');
    try {
      await apiJson('/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir, name: tab.name, content: tab.content }),
      });
      await load(dir);
    } catch (err) {
      setEditorError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const closeTab = (index: number): void => {
    setTabs((prev) => prev.filter((_, i) => i !== index));
    setActiveTab((prev) => Math.max(0, Math.min(index < prev ? prev - 1 : prev, tabs.length - 2)));
  };

  const discardTab = (): void => {
    const tab = tabs[activeTab];
    if (tab === undefined) return;
    setTabs((prev) => prev.map((t, i) => (i === activeTab ? { ...t, content: t.original } : t)));
  };

  const openPreview = async (name: string): Promise<void> => {
    if (isImage(name)) {
      setPreview({ name, kind: 'image' });
      return;
    }
    setEditorError('');
    try {
      const body = await apiJson<{ ok?: unknown; content?: unknown; error?: string }>('/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir, name }),
      });
      if (typeof body.content === 'string') setPreview({ name, kind: 'code', content: body.content });
      else setEditorError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setEditorError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const upload = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setError('');
    try {
      const dataUrl = await readAsDataURL(file);
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir, name: file.name, data: dataUrl.split(',')[1] ?? '' }),
      });
      if (body.ok === true) await load(dir);
      else setError(typeof body.error === 'string' ? body.error : 'Upload failed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    }
  };

  const crumbs = dir === '' ? [] : dir.split('/');
  const crumbPath = (index: number): string => crumbs.slice(0, index + 1).join('/');
  const selectedSize = entries.filter((e) => selected.includes(e.name)).reduce((sum, e) => sum + e.size, 0);

  const visible = entries
    .filter((e) => e.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name);
      if (sortKey === 'size') return a.size - b.size;
      return a.mtime - b.mtime;
    });

  const folders = entries.filter((e) => e.type === 'dir').length;
  const allVisible = visible.length > 0 && visible.every((e) => selected.includes(e.name));

  const toggleSelect = (name: string): void => {
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  };

  const toggleAll = (): void => {
    setSelected(allVisible ? [] : visible.map((e) => e.name));
  };

  const tab = tabs[activeTab];

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-bold">Files</h1>
      <Card className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <p>
          <span className="text-neutral-400">Panel root: </span>
          <span className="font-mono">/{dir}</span>
        </p>
        <p className="text-neutral-400">
          {entries.length} items ({folders} folders, {entries.length - folders} files)
        </p>
        <p className="text-neutral-400">{diskFree === null ? 'disk —' : `disk free ${fmtSize(diskFree)}`}</p>
      </Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="New folder / file name"
          value={newName}
          onChange={(ev) => setNewName(ev.target.value)}
          className="w-56"
        />
        <Button
          size="sm"
          onClick={() => {
            const n = newName.trim();
            if (n === '') return;
            setNewName('');
            void runAction('/api/mkdir', { name: n });
          }}
        >
          Mkdir
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setPromptTouch(true);
          }}
        >
          Touch
        </Button>
        <label className="cursor-pointer text-sm text-green-400">
          Upload
          <input
            type="file"
            className="hidden"
            onChange={(ev) => {
              void upload(ev.target.files?.[0]);
              ev.target.value = '';
            }}
          />
        </label>
        <span className="flex-1" />
        <Input
          placeholder="Search files…"
          aria-label="Search files"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          className="w-44"
        />
        <select
          aria-label="Sort entries"
          className="h-9 rounded-md border border-neutral-700 bg-transparent px-2 text-sm"
          value={sortKey}
          onChange={(ev) => setSortKey(ev.target.value as SortKey)}
        >
          <option value="name">Name</option>
          <option value="size">Size</option>
          <option value="mtime">Modified</option>
        </select>
        <Button size="sm" variant="outline" onClick={() => void load(dir)}>
          Refresh
        </Button>
      </div>
      {selected.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
          <span>
            <strong>{selected.length}</strong> selected
          </span>
          <span className="text-neutral-400">Total size: {fmtSize(selectedSize)}</span>
          <Button size="sm" variant="outline" onClick={() => void bulkZip()}>
            Zip {selected.length}
          </Button>
          <Button size="sm" variant="outline" onClick={bulkDownload}>
            Download
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setPendingBulkDelete(true)}>
            Delete {selected.length}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        </div>
      )}
      {error !== '' && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="mb-2 text-sm text-neutral-400">
        <button type="button" className="hover:text-green-400" onClick={() => void load('')}>
          /
        </button>
        {crumbs.map((crumb, i) => (
          <span key={crumbPath(i)}>
            {' / '}
            <button type="button" className="hover:text-green-400" onClick={() => void load(crumbPath(i))}>
              {crumb}
            </button>
          </span>
        ))}
      </div>
      <Card className="p-0">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <tbody>
            {dir !== '' && (
              <tr>
                <td colSpan={5}>
                  <button type="button" onClick={up}>
                    <Icon name="arrow-up" label="Up" /> ..
                  </button>
                </td>
              </tr>
            )}
            <tr className="text-xs text-neutral-500">
              <td className="w-8">
                <input type="checkbox" aria-label="Select all" checked={allVisible} onChange={toggleAll} />
              </td>
              <td>Name</td>
              <td>Size</td>
              <td>Modified</td>
              <td>Actions</td>
            </tr>
            {visible.map((entry) => (
              <tr key={entry.name} className={selected.includes(entry.name) ? 'bg-emerald-500/5' : undefined}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${entry.name}`}
                    checked={selected.includes(entry.name)}
                    onChange={() => toggleSelect(entry.name)}
                  />
                </td>
                <td>
                  {entry.type === 'dir' ? (
                    <button
                      type="button"
                      className="font-medium hover:text-green-400"
                      onClick={() => void load(dir === '' ? entry.name : `${dir}/${entry.name}`)}
                    >
                      <Icon name="folder" label="Folder" /> {entry.name}
                    </button>
                  ) : (
                    <span className="font-medium">
                      <Icon name="file" label="File" /> {entry.name}
                    </span>
                  )}
                </td>
                <td className="text-neutral-400">{entry.type === 'dir' ? '—' : fmtSize(entry.size)}</td>
                <td className="text-neutral-400">{fmtDate(entry.mtime)}</td>
                <td>
                  <div className="flex gap-1">
                    {entry.type === 'file' && (
                      <>
                        <a
                          className="text-xs text-green-400"
                          href={`/api/download?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(entry.name)}`}
                        >
                          <Icon name="download" label="Download" /> Get
                        </a>
                        <button type="button" className="text-xs" onClick={() => void openEditor(entry.name)}>
                          <Icon name="pencil" label="Edit" /> Edit
                        </button>
                        {(isImage(entry.name) || isPreviewable(entry.name)) && (
                          <button type="button" className="text-xs" onClick={() => void openPreview(entry.name)}>
                            <Icon name="eye" label="Preview" /> View
                          </button>
                        )}
                        {isZip(entry.name) && (
                          <button
                            type="button"
                            className="text-xs"
                            onClick={() => void runAction('/api/files/unzip', { path: dir === '' ? entry.name : `${dir}/${entry.name}` })}
                          >
                            <Icon name="package-open" label="Extract" /> Unzip
                          </button>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      className="text-xs"
                      onClick={() => void runAction('/api/files/zip', { path: dir === '' ? entry.name : `${dir}/${entry.name}` })}
                    >
                      <Icon name="archive" label="Archive" /> Zip
                    </button>
                    <button type="button" className="text-xs" onClick={() => rename(entry.name)}>
                      <Icon name="pencil-line" label="Rename" /> Rename
                    </button>
                    <button type="button" className="text-xs text-red-400" onClick={() => remove(entry.name)}>
                      <Icon name="trash-2" label="Delete" /> Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="text-neutral-400">
                  <EmptyState
                    title={entries.length === 0 ? 'Empty folder' : 'No matches'}
                    hint={entries.length === 0 ? undefined : 'Try another search.'}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </Card>
      <div className="mt-3">
        <ComingSoon feature="Storage mounts & shortcuts" candidate="CAND-019" />
      </div>
      {tabs.length > 0 && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="flex max-h-full w-full max-w-2xl flex-col rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Open files">
              {tabs.map((t, i) => (
                <span
                  key={t.name}
                  role="tab"
                  aria-selected={i === activeTab}
                  className={
                    i === activeTab
                      ? 'flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 font-mono text-xs text-emerald-300'
                      : 'flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs text-neutral-400 hover:bg-neutral-800'
                  }
                >
                  <button type="button" onClick={() => setActiveTab(i)}>
                    {t.name}
                  </button>
                  <button type="button" aria-label={`Close ${t.name}`} className="hover:text-red-400" onClick={() => closeTab(i)}>
                    <i data-lucide="x" className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            {editorError !== '' && (
              <p role="alert" className="mb-2 text-sm text-red-400">
                {editorError}
              </p>
            )}
            {tab !== undefined && (
              <>
                <p className="mb-1 text-xs text-neutral-500">
                  UTF-8 · LF · {tab.content.split('\n').length} lines{tab.content !== tab.original ? ' · edited' : ''}
                </p>
                <CodeEditor
                  filename={tab.name}
                  value={tab.content}
                  onChange={(content) =>
                    setTabs((prev) => prev.map((t, i) => (i === activeTab ? { ...t, content } : t)))
                  }
                  ariaLabel={`Edit ${tab.name}`}
                  viewRef={editorViewRef}
                />
              </>
            )}
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => void saveEditor()}>
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={discardTab}>
                Discard
              </Button>
              <Button size="sm" variant="outline" onClick={() => closeTab(activeTab)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete file"
        message={pendingDelete === null ? '' : `Delete "${pendingDelete}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive={true}
        onConfirm={confirmRemove}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={pendingBulkDelete}
        title="Delete selected"
        message={`Delete ${selected.length} selected items? This cannot be undone.`}
        confirmLabel={`Delete ${selected.length}`}
        destructive={true}
        onConfirm={() => void confirmBulkRemove()}
        onCancel={() => setPendingBulkDelete(false)}
      />
      <PromptDialog
        open={promptRename !== null}
        title="Rename file"
        initialValue={promptRename ?? ''}
        placeholder="New name"
        confirmLabel="Rename"
        onSubmit={confirmRename}
        onCancel={() => setPromptRename(null)}
      />
      <PromptDialog
        open={promptTouch}
        title="New file"
        placeholder="File name:"
        confirmLabel="Create"
        onSubmit={confirmTouch}
        onCancel={() => setPromptTouch(false)}
      />
      {preview !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4" onClick={() => setPreview(null)}>
          {preview.kind === 'image' ? (
            <img
              src={`/api/files/preview?path=${encodeURIComponent(dir === '' ? preview.name : `${dir}/${preview.name}`)}`}
              alt={preview.name}
              className="max-h-full max-w-full"
            />
          ) : (
            <div className="w-full max-w-2xl rounded-lg border border-neutral-800 bg-neutral-900 p-4" onClick={(ev) => ev.stopPropagation()}>
              <h2 className="mb-2 font-mono text-sm font-bold">{preview.name}</h2>
              <CodePreview filename={preview.name} code={preview.content ?? ''} />
              <div className="mt-2">
                <Button size="sm" variant="outline" onClick={() => setPreview(null)}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
