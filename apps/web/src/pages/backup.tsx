import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtDate, fmtSize } from '../lib/format.js';
import { ConfirmDialog } from '../components/common/Dialog.js';
import { Badge } from '../components/common/Badge.js';
import { ComingSoon } from '../components/common/States.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** `/api/backups` row shape (server contract). */
export interface BackupRow {
  name: string;
  file: string;
  type: 'folder' | 'mysql' | 'postgres';
  source: string;
  size: number;
  mtime: number;
  created: number;
}

const BACKUP_TYPES = ['folder', 'mysql', 'postgres'] as const;

/**
 * Backups (mockup backup parity): stats header, storage pool, engine
 * chips, newest-first table with download/restore/delete, dialog-gated
 * destructive actions. Engine chips resolve via the install catalog
 * (`mysqldump` ships with mysql, `pg_dump` with postgres — documented
 * assumption). Honestly omitted (no source, backend frozen): scheduled
 * snapshots, archive upload, SHA256 verify, full-system bundle, gzip
 * variant (CAND-029). Restore uses the stored default target (empty
 * body, Terwo parity).
 */
export function BackupPage(): ReactElement {
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [form, setForm] = useState({ name: '', type: 'folder', source: '' });
  const [error, setError] = useState('');
  const [pendingRestore, setPendingRestore] = useState<BackupRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BackupRow | null>(null);
  const [diskFree, setDiskFree] = useState<number | null>(null);
  const [engines, setEngines] = useState<Record<string, boolean>>({});

  const load = useCallback(async (): Promise<void> => {
    try {
      const body = await apiJson<{ backups?: BackupRow[] }>('/api/backups');
      setBackups(Array.isArray(body.backups) ? body.backups : []);
    } catch {
      // keep the previous render (Terwo parity)
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    void apiJson<{ disk?: { free?: unknown } }>('/api/stats', {}, { unauthorized: 'rethrow' })
      .then((body) => {
        if (alive && typeof body.disk?.free === 'number') setDiskFree(body.disk.free);
      })
      .catch(() => {
        // storage pool keeps its placeholder
      });
    void apiJson<{ items?: Array<{ id?: unknown; installed?: unknown }> }>('/api/install')
      .then((body) => {
        if (!alive || !Array.isArray(body.items)) return;
        const map: Record<string, boolean> = {};
        for (const item of body.items) {
          if (typeof item.id === 'string') map[item.id] = item.installed === true;
        }
        setEngines(map);
      })
      .catch(() => {
        // engine chips stay unknown rather than guessing
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (): Promise<void> => {
    setError('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name.trim(), type: form.type, source: form.source.trim() }),
      });
      if (body.ok === true) {
        setForm({ name: '', type: 'folder', source: '' });
        await load();
      } else setError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const restore = (backup: BackupRow): void => {
    setPendingRestore(backup);
  };

  const confirmRestore = async (): Promise<void> => {
    if (pendingRestore === null) return;
    const name = pendingRestore.name;
    setPendingRestore(null);
    await apiJson(`/api/backups/${encodeURIComponent(name)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => undefined);
    await load();
  };

  const remove = (backup: BackupRow): void => {
    setPendingDelete(backup);
  };

  const confirmRemove = async (): Promise<void> => {
    if (pendingDelete === null) return;
    const name = pendingDelete.name;
    setPendingDelete(null);
    await apiJson(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined);
    await load();
  };

  const sorted = [...backups].sort((a, b) => b.created - a.created);
  const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
  const newest = sorted[0];
  const engineReady = (id: string): boolean | null => (id in engines ? (engines[id] as boolean) : null);

  return (
    <main className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">Backups</h1>
        <Badge tone="info">
          {backups.length} archives · {fmtSize(totalSize)}
        </Badge>
        <span className="text-xs text-neutral-400">
          pool <span className="font-mono">backups/</span> · {diskFree === null ? 'free —' : `${fmtSize(diskFree)} free`}
        </span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Backup engines">
        {[
          { id: 'zip', label: 'Directory zip' },
          { id: 'mysql', label: 'MySQL dump' },
          { id: 'postgres', label: 'Postgres snapshot' },
        ].map((engine) => {
          const ready = engineReady(engine.id);
          return (
            <Badge key={engine.id} tone={ready === true ? 'success' : ready === false ? 'danger' : 'neutral'}>
              {engine.label}: {ready === null ? 'unknown' : ready ? 'ready' : 'missing'}
            </Badge>
          );
        })}
      </div>
      {error !== '' && (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Input placeholder="Backup name (optional)" value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} className="w-52" />
        <select
          aria-label="Backup type"
          className="h-9 rounded-md border border-neutral-700 bg-transparent px-2 text-sm"
          value={form.type}
          onChange={(ev) => setForm({ ...form, type: ev.target.value })}
        >
          {BACKUP_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <Input
          placeholder={form.type === 'folder' ? 'Folder path (empty = root)' : 'Database name'}
          value={form.source}
          onChange={(ev) => setForm({ ...form, source: ev.target.value })}
          className="w-64"
        />
        <Button size="sm" onClick={() => void save()}>
          Create backup
        </Button>
      </div>
      <Card className="p-0">
        <table className="w-full text-sm">
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td className="text-neutral-400">No backups yet</td>
              </tr>
            ) : (
              sorted.map((backup) => (
                <tr key={backup.name}>
                  <td>
                    {backup.name}
                    {newest?.name === backup.name && (
                      <span className="ml-2 text-[11px] text-emerald-400">latest · {fmtDate(backup.mtime)}</span>
                    )}
                  </td>
                  <td className="text-neutral-400">{backup.type}</td>
                  <td className="font-mono text-xs text-neutral-400">{backup.source === '' ? '—' : backup.source}</td>
                  <td className="text-neutral-400">{fmtSize(backup.size)}</td>
                  <td>
                    <div className="flex gap-1">
                      <a className="text-xs text-green-400" href={`/api/backups/${encodeURIComponent(backup.name)}/download`}>
                        Download
                      </a>
                      <Button size="sm" variant="outline" onClick={() => void restore(backup)}>
                        Restore
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => void remove(backup)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
      <ConfirmDialog
        open={pendingRestore !== null}
        title="Restore backup"
        message={pendingRestore === null ? '' : `Restore backup "${pendingRestore.name}"? Current files may be overwritten.`}
        confirmLabel="Restore"
        destructive={true}
        onConfirm={() => void confirmRestore()}
        onCancel={() => setPendingRestore(null)}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete backup"
        message={pendingDelete === null ? '' : `Delete backup "${pendingDelete.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive={true}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingDelete(null)}
      />
      <div className="mt-3">
        <ComingSoon feature="Scheduled snapshots, upload & verify" candidate="CAND-029" />
      </div>
    </main>
  );
}
