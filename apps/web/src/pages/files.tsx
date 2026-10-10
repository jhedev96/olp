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
  createIcons,
} from 'lucide';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtDate, fmtSize } from '../lib/format.js';
import { ConfirmDialog, PromptDialog } from '../components/common/Dialog.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** Tree-shaken icon set for this page (passed to `createIcons` per render). */
const ICONS = { Archive, ArrowUp, Download, Eye, File: FileIcon, Folder, PackageOpen, Pencil, PencilLine, Trash2 };

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

/**
 * File manager (Terwo files-tab parity): crumbs + up-row, per-type row
 * actions, dialog-driven mkdir/touch/rename, dialog-gated delete,
 * base64 upload, in-browser text editor modal, image preview modal.
 */
export function FilesPage(): ReactElement {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ name: string; content: string } | null>(null);
  const [editorError, setEditorError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [promptRename, setPromptRename] = useState<string | null>(null);
  const [promptTouch, setPromptTouch] = useState(false);

  const load = useCallback(async (target: string): Promise<void> => {
    setError('');
    try {
      const body = await apiJson<{ path: string; entries: FileEntry[] }>(
        `/api/files?path=${encodeURIComponent(target)}`,
      );
      setDir(body.path);
      setEntries(body.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

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
    setEditorError('');
    try {
      const body = await apiJson<{ ok?: unknown; content?: unknown; error?: string }>('/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir, name }),
      });
      if (typeof body.content === 'string') setEditor({ name, content: body.content });
      else setEditorError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setEditorError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const saveEditor = async (): Promise<void> => {
    if (editor === null) return;
    setEditorError('');
    try {
      await apiJson('/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dir, name: editor.name, content: editor.content }),
      });
      setEditor(null);
      await load(dir);
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

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-bold">Files</h1>
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
      </div>
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
        <table className="w-full text-sm">
          <tbody>
            {dir !== '' && (
              <tr>
                <td colSpan={4}>
                  <button type="button" onClick={up}>
                    <Icon name="arrow-up" label="Up" /> ..
                  </button>
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.name}>
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
                        {isImage(entry.name) && (
                          <button type="button" className="text-xs" onClick={() => setPreview(entry.name)}>
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
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="text-neutral-400">
                  Empty folder
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {editor !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-2 font-bold">{editor.name}</h2>
            {editorError !== '' && (
              <p role="alert" className="mb-2 text-sm text-red-400">
                {editorError}
              </p>
            )}
            <textarea
              className="h-64 w-full rounded border border-neutral-700 bg-transparent p-2 font-mono text-sm"
              value={editor.content}
              onChange={(ev) => setEditor({ name: editor.name, content: ev.target.value })}
            />
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => void saveEditor()}>
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditor(null)}>
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
          <img
            src={`/api/files/preview?path=${encodeURIComponent(dir === '' ? preview : `${dir}/${preview}`)}`}
            alt={preview}
            className="max-h-full max-w-full"
          />
        </div>
      )}
    </main>
  );
}
