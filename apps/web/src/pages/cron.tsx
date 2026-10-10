import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { ConfirmDialog } from '../components/common/Dialog.js';
import { ComingSoon } from '../components/common/States.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** `/api/cron/jobs` row shape (server contract). */
export interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
}

/** Schedule presets (Terwo preset parity; `custom` unlocks the input). */
const PRESETS: Array<{ value: string; label: string }> = [
  { value: '* * * * *', label: 'Every minute' },
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 0 * * *', label: 'Every day' },
  { value: '0 0 * * 0', label: 'Every week' },
  { value: '0 0 1 * *', label: 'Every month' },
  { value: 'custom', label: 'Custom…' },
];

/**
 * Render loaded jobs as crontab text (the server backend is real
 * `crontab(1)`; this is the same data in file format, read-only).
 */
export function crontabText(jobs: CronJobRow[]): string {
  return jobs.map((j) => `# ${j.name}${j.enabled ? '' : ' (disabled)'}\n${j.schedule} ${j.command}`).join('\n');
}

/**
 * Cron scheduler (mockup cron parity): daemon status + start/stop,
 * preset-driven add form, search + status filter, jobs table with
 * enable/disable + dialog-gated delete, read-only crontab preview.
 * Honestly omitted (no source, backend frozen): daemon PID, dry-run
 * all, next-run countdown, dispatch stats (CAND-028); spool paths vary
 * per OS with no endpoint. Job rows carry no category field, so search
 * covers filtering (no invented taxonomy). List failures keep the
 * previous render.
 */
export function CronPage(): ReactElement {
  const [running, setRunning] = useState<boolean | null>(null);
  const [jobs, setJobs] = useState<CronJobRow[]>([]);
  const [preset, setPreset] = useState(PRESETS[0]?.value ?? '* * * * *');
  const [form, setForm] = useState({ name: '', schedule: '', command: '' });
  const [error, setError] = useState('');
  const [pendingJob, setPendingJob] = useState<CronJobRow | null>(null);
  const [query, setQuery] = useState('');
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [showCrontab, setShowCrontab] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const status = await apiJson<{ running: boolean }>('/api/cron/status');
      setRunning(status.running);
    } catch {
      // keep previous
    }
    try {
      const body = await apiJson<{ jobs: CronJobRow[] }>('/api/cron/jobs');
      setJobs(body.jobs);
    } catch {
      // keep previous
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const service = async (action: 'start' | 'stop'): Promise<void> => {
    await apiJson('/api/cron/service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }).catch(() => undefined);
    await load();
  };

  const save = async (): Promise<void> => {
    setError('');
    try {
      const body = await apiJson<{ ok?: unknown; error?: string }>('/api/cron/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          schedule: preset === 'custom' ? form.schedule.trim() : preset,
          command: form.command.trim(),
        }),
      });
      if (body.ok === true) {
        setForm({ name: '', schedule: '', command: '' });
        await load();
      } else setError(typeof body.error === 'string' ? body.error : 'Failed');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const toggle = async (id: string): Promise<void> => {
    await apiJson(`/api/cron/jobs/${id}/toggle`, { method: 'POST' }).catch(() => undefined);
    await load();
  };

  const remove = (job: CronJobRow): void => {
    setPendingJob(job);
  };

  const confirmRemove = async (): Promise<void> => {
    if (pendingJob === null) return;
    const id = pendingJob.id;
    setPendingJob(null);
    await apiJson(`/api/cron/jobs/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await load();
  };

  const q = query.trim().toLowerCase();
  const visible = jobs.filter(
    (job) =>
      (enabledFilter === 'all' || (enabledFilter === 'enabled') === job.enabled) &&
      (q === '' || job.name.toLowerCase().includes(q) || job.schedule.includes(q) || job.command.toLowerCase().includes(q)),
  );

  return (
    <main className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">Cron</h1>
        <span className="text-xs text-neutral-400">
          {jobs.filter((j) => j.enabled).length} active · {jobs.filter((j) => !j.enabled).length} paused
        </span>
        <Button size="sm" variant="outline" onClick={() => setShowCrontab(true)}>
          View crontab
        </Button>
        <Button size="sm" variant="outline" disabled={true} title="Coming soon (CAND-028)">
          Dry-run all
        </Button>
      </div>
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className={running === true ? 'text-green-400' : 'text-neutral-400'}>
          {running === null ? '…' : running ? 'crond running' : 'crond stopped'}
        </span>
        <Button size="sm" variant="outline" onClick={() => void service('start')}>
          Start
        </Button>
        <Button size="sm" variant="outline" onClick={() => void service('stop')}>
          Stop
        </Button>
      </div>
      {error !== '' && (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Input placeholder="Job name" value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} className="w-40" />
        <select
          aria-label="Schedule preset"
          className="h-9 rounded-md border border-neutral-700 bg-transparent px-2 text-sm"
          value={preset}
          onChange={(ev) => setPreset(ev.target.value)}
        >
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <Input
          placeholder="* * * * *"
          aria-label="Custom schedule"
          value={form.schedule}
          disabled={preset !== 'custom'}
          onChange={(ev) => setForm({ ...form, schedule: ev.target.value })}
          className="w-36"
        />
        <Input placeholder="Command" value={form.command} onChange={(ev) => setForm({ ...form, command: ev.target.value })} className="w-64" />
        <Button size="sm" onClick={() => void save()}>
          Add job
        </Button>
        <span className="flex-1" />
        <Input
          placeholder="Search jobs…"
          aria-label="Search jobs"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          className="w-44"
        />
        <select
          aria-label="Filter job status"
          className="h-9 rounded-md border border-neutral-700 bg-transparent px-2 text-sm"
          value={enabledFilter}
          onChange={(ev) => setEnabledFilter(ev.target.value as 'all' | 'enabled' | 'disabled')}
        >
          <option value="all">All</option>
          <option value="enabled">Enabled only</option>
          <option value="disabled">Disabled only</option>
        </select>
      </div>
      <Card className="p-0">
        <table className="w-full text-sm">
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td className="text-neutral-400">{jobs.length === 0 ? 'No jobs yet' : 'No matches'}</td>
              </tr>
            ) : (
              visible.map((job) => (
                <tr key={job.id}>
                  <td>{job.name}</td>
                  <td className="font-mono text-xs text-neutral-400">{job.schedule}</td>
                  <td className="font-mono text-xs text-neutral-400">{job.command}</td>
                  <td>
                    <span className={job.enabled ? 'text-green-400' : 'text-neutral-500'}>
                      {job.enabled ? 'Enabled' : 'Stopped'}
                    </span>
                  </td>
                  <td>
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => void toggle(job.id)}>
                        {job.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => void remove(job)}>
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
        open={pendingJob !== null}
        title="Delete cron job"
        message={pendingJob === null ? '' : `Delete cron job "${pendingJob.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive={true}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingJob(null)}
      />
      <div className="mt-3">
        <ComingSoon feature="Dispatch stats & history" candidate="CAND-028" />
      </div>
      {showCrontab && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-2 font-bold">Crontab (read-only)</h2>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs">{crontabText(jobs)}</pre>
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => setShowCrontab(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
