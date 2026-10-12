import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtDate, fmtSize } from '../lib/format.js';
import { ConfirmDialog } from '../components/common/Dialog.js';
import { Badge } from '../components/common/Badge.js';
import { DataTable } from '../components/common/DataTable.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { readAsDataURL } from './files.js';

/** `/api/backups` row shape (server contract). */
export interface BackupRow {
  name: string;
  file: string;
  type: 'folder' | 'mysql' | 'postgres';
  source: string;
  size: number;
  mtime: number;
  created: number;
  sha256?: string;
}

/** `/api/backups/schedules` row shape. */
export interface BackupScheduleRow {
  id: string;
  name: string;
  type: 'folder' | 'mysql' | 'postgres';
  source: string;
  schedule: string;
  enabled: boolean;
  created: number;
  lastRun: number | null;
  lastStatus: string | null;
  nextRun: number | null;
}

/** `/api/backups/:name/verify` shape. */
export interface VerifyState {
  sha256: string;
  match: boolean | null;
}

const BACKUP_TYPES = ['folder', 'mysql', 'postgres'] as const;

/**
 * Backups (mockup backup parity): stats header, storage pool, engine
 * chips, newest-first table with download/restore/delete/verify,
 * gzip dumps, archive upload, scheduled snapshots with last-run, and
 * dialog-gated destructive actions. Engine chips resolve via the
 * install catalog (`mysqldump` ships with mysql, `pg_dump` with
 * postgres — documented assumption). Full-system bundle stays out
 * (CAND-035); auto-prune stays out (retention design needed). Restore
 * uses the stored default target (empty body, Terwo parity).
 */
export function BackupPage(): ReactElement {
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [form, setForm] = useState({ name: '', type: 'folder', source: '' });
  const [error, setError] = useState('');
  const [pendingRestore, setPendingRestore] = useState<BackupRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BackupRow | null>(null);
  const [diskFree, setDiskFree] = useState<number | null>(null);
  const [engines, setEngines] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [oldestFirst, setOldestFirst] = useState(false);
  const [gzip, setGzip] = useState(false);
  const [verifyMap, setVerifyMap] = useState<Record<string, VerifyState | null>>({});
  const [schedules, setSchedules] = useState<BackupScheduleRow[]>([]);
  const [schedForm, setSchedForm] = useState({ name: '', type: 'folder', source: '', schedule: '0 2 * * *' });
  const [uploadType, setUploadType] = useState('folder');

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
        body: JSON.stringify({ name: form.name.trim(), type: form.type, source: form.source.trim(), gzip: form.type !== 'folder' && gzip }),
      });
      if (body.ok === true) {
        setForm({ name: '', type: 'folder', source: '' });
        await load();
      } else setError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const verify = async (backup: BackupRow): Promise<void> => {
    setError('');
    try {
      const body = await apiJson<VerifyState & { ok?: unknown }>(`/api/backups/${encodeURIComponent(backup.name)}/verify`);
      setVerifyMap((prev) => ({ ...prev, [backup.name]: { sha256: body.sha256, match: body.match } }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const upload = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setError('');
    try {
      const dataUrl = await readAsDataURL(file);
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/backups/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: uploadType, data: dataUrl.split(',')[1] ?? '' }),
      });
      if (body.ok === true) await load();
      else setError(typeof body.error === 'string' ? body.error : 'Upload failed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    }
  };

  const loadSchedules = useCallback(async (): Promise<void> => {
    try {
      const body = await apiJson<{ schedules: BackupScheduleRow[] }>('/api/backups/schedules');
      if (Array.isArray(body.schedules)) setSchedules(body.schedules);
    } catch {
      // schedules section keeps the previous render
    }
  }, []);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  const saveSchedule = async (): Promise<void> => {
    setError('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/backups/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: schedForm.name.trim(),
          type: schedForm.type,
          source: schedForm.source.trim(),
          schedule: schedForm.schedule.trim(),
        }),
      });
      if (body.ok === true) {
        setSchedForm({ name: '', type: 'folder', source: '', schedule: '0 2 * * *' });
        await loadSchedules();
      } else setError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const toggleSchedule = async (id: string): Promise<void> => {
    await apiJson(`/api/backups/schedules/${id}/toggle`, { method: 'POST' }).catch(() => undefined);
    await loadSchedules();
  };

  const removeSchedule = async (id: string): Promise<void> => {
    await apiJson(`/api/backups/schedules/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await loadSchedules();
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

  const q = query.trim().toLowerCase();
  const sorted = [...backups]
    .filter(
      (b) =>
        (typeFilter === 'all' || b.type === typeFilter) &&
        (q === '' || b.name.toLowerCase().includes(q) || b.source.toLowerCase().includes(q)),
    )
    .sort((a, b) => (oldestFirst ? a.created - b.created : b.created - a.created));
  const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
  const newest = [...backups].sort((a, b) => b.created - a.created)[0];
  const dbCoverage = backups.filter((b) => b.type === 'mysql' || b.type === 'postgres').length;
  const engineReady = (id: string): boolean | null => (id in engines ? (engines[id] as boolean) : null);

  return (
    <main className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">Backups</h1>
        <Badge tone="info">
          {backups.length} archives · {fmtSize(totalSize)}
        </Badge>
        {dbCoverage > 0 && <Badge tone="success">{dbCoverage} database dumps</Badge>}
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
        {form.type !== 'folder' && (
          <label className="flex items-center gap-1 text-sm text-neutral-300">
            <input type="checkbox" checked={gzip} onChange={(ev) => setGzip(ev.target.checked)} />
            Gzip (.sql.gz)
          </label>
        )}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          aria-label="Upload type"
          className="h-9 rounded-md border border-neutral-700 bg-transparent px-2 text-sm"
          value={uploadType}
          onChange={(ev) => setUploadType(ev.target.value)}
        >
          {BACKUP_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <label className="cursor-pointer rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800">
          Upload archive
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Filter snapshots…"
          aria-label="Filter snapshots"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          className="w-52"
        />
        {['all', 'folder', 'mysql', 'postgres'].map((type) => {
          const count = type === 'all' ? backups.length : backups.filter((b) => b.type === type).length;
          return (
            <Button key={type} size="sm" variant={typeFilter === type ? 'default' : 'outline'} onClick={() => setTypeFilter(type)}>
              {type === 'all' ? `All (${count})` : `${type} (${count})`}
            </Button>
          );
        })}
        <select
          aria-label="Snapshot order"
          className="h-9 rounded-md border border-neutral-700 bg-transparent px-2 text-sm"
          value={oldestFirst ? 'oldest' : 'newest'}
          onChange={(ev) => setOldestFirst(ev.target.value === 'oldest')}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <div className="overflow-x-auto">
        <DataTable<BackupRow>
          label="Backups"
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (backup) => (
                <>
                  {backup.name}
                  {newest?.name === backup.name && (
                    <span className="ml-2 text-[11px] text-emerald-400">latest · {fmtDate(backup.mtime)}</span>
                  )}
                </>
              ),
            },
            { key: 'type', header: 'Type', cell: (backup) => <span className="text-neutral-400">{backup.type}</span> },
            {
              key: 'source',
              header: 'Source',
              cell: (backup) => (
                <span className="font-mono text-xs text-neutral-400">{backup.source === '' ? '—' : backup.source}</span>
              ),
            },
            { key: 'size', header: 'Size', cell: (backup) => <span className="text-neutral-400">{fmtSize(backup.size)}</span> },
            {
              key: 'actions',
              header: 'Actions',
              cell: (backup) => {
                const verified = verifyMap[backup.name];
                return (
                  <div className="flex flex-wrap items-center gap-1">
                    <a className="text-xs text-green-400" href={`/api/backups/${encodeURIComponent(backup.name)}/download`}>
                      Download
                    </a>
                    <Button size="sm" variant="outline" onClick={() => void restore(backup)}>
                      Restore
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void verify(backup)}>
                      Verify
                    </Button>
                    {verified !== undefined && verified !== null && (
                      <Badge tone={verified.match === false ? 'danger' : 'success'}>
                        {verified.match === null ? 'hash, unverified' : verified.match ? 'SHA256 OK' : 'MISMATCH'}
                      </Badge>
                    )}
                    <Button size="sm" variant="destructive" onClick={() => void remove(backup)}>
                      Delete
                    </Button>
                  </div>
                );
              },
            },
          ]}
          rows={sorted}
          rowKey={(backup) => backup.name}
          emptyText="No backups yet"
        />
      </div>
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
        <Card>
          <h2 className="mb-2 font-bold">Scheduled snapshots</h2>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <Input placeholder="Schedule name (optional)" value={schedForm.name} onChange={(ev) => setSchedForm({ ...schedForm, name: ev.target.value })} className="w-48" />
            <select
              aria-label="Scheduled type"
              className="h-9 rounded-md border border-neutral-700 bg-transparent px-2 text-sm"
              value={schedForm.type}
              onChange={(ev) => setSchedForm({ ...schedForm, type: ev.target.value })}
            >
              {BACKUP_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <Input placeholder="Folder path or database" value={schedForm.source} onChange={(ev) => setSchedForm({ ...schedForm, source: ev.target.value })} className="w-56" />
            <Input
              placeholder="* * * * *"
              aria-label="Scheduled cron expression"
              value={schedForm.schedule}
              onChange={(ev) => setSchedForm({ ...schedForm, schedule: ev.target.value })}
              className="w-36"
            />
            <Button size="sm" onClick={() => void saveSchedule()}>
              Add schedule
            </Button>
          </div>
          {schedules.length === 0 ? (
            <p className="text-sm text-neutral-400">No schedules yet — snapshots run while the panel is up.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {schedules.map((sched) => (
                <li key={sched.id} className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 px-2 py-1.5 text-sm">
                  <span className="mr-auto font-medium">{sched.name}</span>
                  <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs text-emerald-300">{sched.schedule}</code>
                  <span className="font-mono text-xs text-neutral-400">{sched.type}:{sched.source}</span>
                  <span className="text-xs text-neutral-400">
                    {sched.lastRun === null ? 'never ran' : `last ${fmtDate(sched.lastRun)}${sched.lastStatus === null || sched.lastStatus === 'ok' ? '' : ` · ${sched.lastStatus}`}`}
                  </span>
                  <span className={sched.enabled ? 'text-xs text-green-400' : 'text-xs text-neutral-500'}>
                    {sched.enabled ? 'Enabled' : 'Stopped'}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void toggleSchedule(sched.id)}>
                    {sched.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => void removeSchedule(sched.id)}>
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}
