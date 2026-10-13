import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtDate, fmtSize } from '../lib/format.js';
import { navigateTo } from '../lib/router.js';
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

/** `/api/bundles` manifest shape (server contract). */
export interface BundlePartRow {
  name: string;
  file: string;
  kind: 'mysql' | 'postgres' | 'configs' | 'crons';
  sha256: string;
}

/** `/api/bundles` row shape. */
export interface BundleRow {
  id: string;
  created: number;
  parts: BundlePartRow[];
  hasAuth?: boolean;
}

/** Bundle job step shape (snapshot + restore share it). */
export interface BundleStepRow {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'ok' | 'failed';
  detail: string;
}

/** Bundle job shape (`GET /api/bundles/:id` + `/api/bundles/restores/:id`). */
export interface BundleJobRow {
  id: string;
  state: 'running' | 'done' | 'failed';
  steps: BundleStepRow[];
  started: number;
  finished: number | null;
}

const BACKUP_TYPES = ['folder', 'mysql', 'postgres'] as const;
const BUNDLE_ENGINES = ['mysql', 'postgres'] as const;
/** Live step poll cadence (documented; jobs run server-side). */
const BUNDLE_POLL_MS = 2000;

/**
 * Backups (mockup backup parity): stats header, storage pool, engine
 * chips, newest-first table with download/restore/delete/verify,
 * gzip dumps, archive upload, scheduled snapshots with last-run, and
 * dialog-gated destructive actions. Engine chips resolve via the
 * install catalog (`mysqldump` ships with mysql, `pg_dump` with
 * postgres — documented assumption). Full-system bundles ship as a
 * manifest + parts card (snapshot checklist dialog, bundles list with
 * per-part verify/download, danger-guarded restore-all with live
 * step poll); auto-prune stays out (retention design needed).
 * Restore uses the stored default target (empty body, Terwo parity).
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
  const [bundles, setBundles] = useState<BundleRow[]>([]);
  const [showBundleDialog, setShowBundleDialog] = useState(false);
  const [discovered, setDiscovered] = useState<Record<string, string[] | null>>({ mysql: null, postgres: null });
  const [checked, setChecked] = useState<Record<string, Record<string, boolean>>>({ mysql: {}, postgres: {} });
  const [includeConfigs, setIncludeConfigs] = useState(true);
  const [includeCrons, setIncludeCrons] = useState(true);
  const [activeSnapshot, setActiveSnapshot] = useState<BundleJobRow | null>(null);
  const [pendingBundleRestore, setPendingBundleRestore] = useState<BundleRow | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreStatus, setRestoreStatus] = useState<{ bundleId: string; job: BundleJobRow } | null>(null);
  const [restoreLoggedOut, setRestoreLoggedOut] = useState(false);

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

  const loadBundles = useCallback(async (): Promise<void> => {
    try {
      const body = await apiJson<{ bundles?: BundleRow[] }>('/api/bundles');
      setBundles(Array.isArray(body.bundles) ? body.bundles : []);
    } catch {
      // bundles list keeps its previous render
    }
  }, []);

  useEffect(() => {
    void loadBundles();
  }, [loadBundles]);

  const openBundleDialog = (): void => {
    setDiscovered({ mysql: null, postgres: null });
    setShowBundleDialog(true);
    for (const engine of BUNDLE_ENGINES) {
      void apiJson<{ databases?: unknown }>(`/api/db/${engine}/databases`)
        .then((body) => {
          const list = Array.isArray(body.databases) ? body.databases.filter((db): db is string => typeof db === 'string') : [];
          setDiscovered((prev) => ({ ...prev, [engine]: list }));
          setChecked((prev) => {
            const next: Record<string, boolean> = { ...(prev[engine] ?? {}) };
            for (const db of list) {
              if (!(db in next)) next[db] = true;
            }
            return { ...prev, [engine]: next };
          });
        })
        .catch(() => {
          // engine stays null: not connected, honestly skipped
        });
    }
  };

  const pollSnapshot = useCallback(
    async (id: string): Promise<void> => {
      try {
        const body = await apiJson<{ bundle?: BundleRow | null; job?: BundleJobRow | null }>(`/api/bundles/${encodeURIComponent(id)}`);
        if (body.job !== null && body.job !== undefined) {
          if (body.job.state === 'running') {
            setActiveSnapshot(body.job);
          } else {
            setActiveSnapshot(null);
            await loadBundles();
            await load();
          }
        }
      } catch {
        // next tick retries
      }
    },
    [load, loadBundles],
  );

  useEffect(() => {
    if (activeSnapshot === null) return;
    const id = activeSnapshot.id;
    const timer = setInterval(() => {
      void pollSnapshot(id);
    }, BUNDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [activeSnapshot, pollSnapshot]);

  const startBundle = async (): Promise<void> => {
    setError('');
    const databases: { mysql: string[]; postgres: string[] } = { mysql: [], postgres: [] };
    for (const engine of BUNDLE_ENGINES) {
      const list = discovered[engine] ?? [];
      databases[engine as 'mysql' | 'postgres'] = list.filter((db) => checked[engine]?.[db] === true);
    }
    try {
      const body = await apiJson<{ ok?: unknown; error?: string; id?: unknown }>('/api/bundles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ databases, configs: includeConfigs, crons: includeCrons }),
      });
      if (typeof body.id !== 'string') {
        setError(typeof body.error === 'string' ? body.error : 'Snapshot failed to start');
        return;
      }
      setShowBundleDialog(false);
      setActiveSnapshot({ id: body.id, state: 'running', steps: [], started: Date.now(), finished: null });
      await pollSnapshot(body.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Snapshot failed to start');
    }
  };

  const pollRestore = useCallback(async (bundleId: string, rid: string): Promise<void> => {
    try {
      // Rethrow (no blind redirect): a 401 here is the expected logout
      // after a credential restore, shown inline with a login button.
      const body = await apiJson<{ job?: BundleJobRow }>(`/api/bundles/restores/${encodeURIComponent(rid)}`, {}, { unauthorized: 'rethrow' });
      if (body.job !== undefined) setRestoreStatus({ bundleId, job: body.job });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setRestoreLoggedOut(true);
        return;
      }
      // next tick retries
    }
  }, []);

  useEffect(() => {
    if (restoreStatus === null || restoreStatus.job.state !== 'running' || restoreLoggedOut) return;
    const { bundleId, job } = restoreStatus;
    const timer = setInterval(() => {
      void pollRestore(bundleId, job.id);
    }, BUNDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [restoreStatus, restoreLoggedOut, pollRestore]);

  const confirmBundleRestore = async (): Promise<void> => {
    if (pendingBundleRestore === null) return;
    const bundleId = pendingBundleRestore.id;
    const withAuth = pendingBundleRestore.hasAuth === true;
    const password = restorePassword;
    setPendingBundleRestore(null);
    setRestorePassword('');
    setRestoreLoggedOut(false);
    setError('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string; id?: unknown }>(`/api/bundles/${encodeURIComponent(bundleId)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withAuth ? { currentPassword: password } : {}),
      });
      if (typeof body.id !== 'string') {
        setError(typeof body.error === 'string' ? body.error : 'Restore failed to start');
        return;
      }
      setRestoreStatus({ bundleId, job: { id: body.id, state: 'running', steps: [], started: Date.now(), finished: null } });
      await pollRestore(bundleId, body.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Restore failed to start');
    }
  };

  const verifyPart = async (name: string): Promise<void> => {
    try {
      const body = await apiJson<VerifyState & { ok?: unknown }>(`/api/backups/${encodeURIComponent(name)}/verify`);
      setVerifyMap((prev) => ({ ...prev, [name]: { sha256: body.sha256, match: body.match } }));
    } catch {
      // badge stays absent; errors surface on the archive table instead
    }
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
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto font-bold">Full system snapshots</h2>
            <Button size="sm" onClick={() => openBundleDialog()}>
              Start full snapshot
            </Button>
          </div>
          {activeSnapshot !== null && (
            <div className="mb-2 rounded border border-neutral-800 px-2 py-1.5 text-sm" aria-live="polite">
              <p className="font-medium">Snapshot running…</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {activeSnapshot.steps.map((step) => (
                  <li key={step.key} className="font-mono text-xs text-neutral-400">
                    {step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '…'} {step.label}
                    {step.detail !== '' && <span className="text-neutral-500"> — {step.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {bundles.length === 0 ? (
            <p className="text-sm text-neutral-400">No full-system bundles yet — one click snapshots every database plus configs and cron jobs.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {bundles.map((bundle) => (
                <li key={bundle.id} className="rounded border border-neutral-800 px-2 py-1.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-auto font-mono text-xs">{bundle.id}</span>
                    <span className="text-xs text-neutral-400">{fmtDate(bundle.created)}</span>
                    <span className="text-xs text-neutral-400">
                      {bundle.parts.filter((p) => p.kind === 'mysql' || p.kind === 'postgres').length} db ·{' '}
                      {bundle.parts.some((p) => p.kind === 'configs') ? 'configs' : 'no configs'} ·{' '}
                      {bundle.parts.some((p) => p.kind === 'crons') ? 'crons' : 'no crons'}
                    </span>
                    <Button size="sm" variant="destructive" onClick={() => setPendingBundleRestore(bundle)}>
                      Restore all
                    </Button>
                  </div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {bundle.parts.map((part) => {
                      const verified = verifyMap[part.name];
                      const kind = part.kind;
                      const restorableKind = kind === 'mysql' || kind === 'postgres' ? kind : null;
                      return (
                        <li key={part.name} className="flex flex-wrap items-center gap-2 font-mono text-xs text-neutral-400">
                          <span>
                            {part.kind}: {part.file}
                          </span>
                          <a className="text-green-400" href={`/api/backups/${encodeURIComponent(part.name)}/download`}>
                            Download
                          </a>
                          <Button size="sm" variant="outline" onClick={() => void verifyPart(part.name)}>
                            Verify
                          </Button>
                          {verified !== undefined && verified !== null && (
                            <Badge tone={verified.match === false ? 'danger' : 'success'}>
                              {verified.match === null ? 'hash, unverified' : verified.match ? 'SHA256 OK' : 'MISMATCH'}
                            </Badge>
                          )}
                          {restorableKind !== null && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setPendingRestore({ name: part.name, file: part.file, type: restorableKind, source: '', size: 0, mtime: 0, created: bundle.created })
                              }
                            >
                              Restore
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {restoreStatus !== null && restoreStatus.bundleId === bundle.id && (
                    <div className="mt-1 rounded border border-red-900 px-2 py-1.5" aria-live="polite">
                      {restoreLoggedOut ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="mr-auto text-xs font-medium">
                            Logged out — the credential restore revoked all sessions. Log in with the restored credentials.
                          </p>
                          <Button size="sm" variant="outline" onClick={() => navigateTo('login')}>
                            Go to login
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="mr-auto text-xs font-medium">
                              Restore {restoreStatus.job.state === 'running' ? 'running…' : restoreStatus.job.state === 'done' ? 'done' : 'failed'}
                            </p>
                            {restoreStatus.job.state !== 'running' && (
                              <Button size="sm" variant="outline" onClick={() => setRestoreStatus(null)}>
                                Dismiss
                              </Button>
                            )}
                          </div>
                          <ul className="mt-1 flex flex-col gap-0.5">
                            {restoreStatus.job.steps.map((step) => (
                              <li key={step.key} className="font-mono text-xs text-neutral-400">
                                {step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '…'} {step.label}
                                {step.detail !== '' && <span className="text-neutral-500"> — {step.detail}</span>}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {showBundleDialog && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-label="Full system snapshot">
          <div className="w-full max-w-lg rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-2 font-bold">Full system snapshot</h2>
            {BUNDLE_ENGINES.map((engine) => {
              const list = discovered[engine] ?? null;
              return (
                <div key={engine} className="mb-2">
                  <p className="text-sm font-medium">{engine}</p>
                  {list === null ? (
                    <p className="text-xs text-neutral-500">Not connected — skipped. Connect in Database first to include {engine} dumps.</p>
                  ) : list.length === 0 ? (
                    <p className="text-xs text-neutral-500">No user databases.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {list.map((db) => (
                        <li key={db}>
                          <label className="flex items-center gap-2 text-sm text-neutral-300">
                            <input
                              type="checkbox"
                              checked={checked[engine]?.[db] === true}
                              onChange={(ev) =>
                                setChecked((prev) => ({ ...prev, [engine]: { ...(prev[engine] ?? {}), [db]: ev.target.checked } }))
                              }
                            />
                            <span className="font-mono text-xs">{db}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input type="checkbox" checked={includeConfigs} onChange={(ev) => setIncludeConfigs(ev.target.checked)} />
              Include configs (sites, credentials, settings, proxies)
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <input type="checkbox" checked={includeCrons} onChange={(ev) => setIncludeCrons(ev.target.checked)} />
              Include cron jobs
            </label>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => void startBundle()}>
                Start snapshot
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowBundleDialog(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={pendingBundleRestore !== null && pendingBundleRestore.hasAuth !== true}
        title="Restore full system"
        message={
          pendingBundleRestore === null
            ? ''
            : `Restore bundle "${pendingBundleRestore.id}"? This drops and recreates every bundled database, overwrites panel configs, and re-adds missing cron jobs. Current data may be lost.`
        }
        confirmLabel="Restore all"
        destructive={true}
        onConfirm={() => void confirmBundleRestore()}
        onCancel={() => setPendingBundleRestore(null)}
      />
      {pendingBundleRestore !== null && pendingBundleRestore.hasAuth === true && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-label="Restore full system">
          <div className="w-full max-w-lg rounded-lg border border-red-900 bg-neutral-900 p-4">
            <h2 className="mb-2 font-bold">Restore full system</h2>
            <p className="mb-2 text-sm text-neutral-300">
              Restore bundle &ldquo;{pendingBundleRestore.id}&rdquo;? This drops and recreates every bundled database, overwrites panel
              configs, restores the bundled login credentials, and re-adds missing cron jobs. Current data may be lost.
            </p>
            <p className="mb-2 text-sm font-medium text-red-400">You will be logged out immediately. Enter the current password to confirm.</p>
            <Input
              type="password"
              autoComplete="current-password"
              aria-label="Current password"
              placeholder="Current password"
              value={restorePassword}
              onChange={(ev) => setRestorePassword(ev.target.value)}
              className="w-full"
            />
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => void confirmBundleRestore()}>
                Restore all
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPendingBundleRestore(null);
                  setRestorePassword('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
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
