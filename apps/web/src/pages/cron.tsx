import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
import { fmtDate, fmtUptime } from '../lib/format.js';
import { ConfirmDialog } from '../components/common/Dialog.js';
import { Badge } from '../components/common/Badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';

/** `/api/cron/jobs` row shape (server contract, nextRun additive). */
export interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  nextRun: number | null;
}

/** `/api/cron/runs` row shape. */
export interface CronRunRow {
  id: string;
  jobId: string;
  name: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  latencyMs: number;
}

/** `/api/cron/jobs/dry-run` row shape. */
export interface DryRunRow {
  id: string;
  name: string;
  enabled: boolean;
  ok: boolean;
  nextRun: number | null;
  resolved: boolean;
  error: string | null;
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
 * Cron scheduler (mockup cron parity): daemon status + PID + start/stop,
 * preset-driven add form, search + status filter, job cards with
 * enable/disable + dialog-gated delete, Run Now with captured results,
 * dry-run-all modal, dispatch stats (panel-triggered runs only),
 * next-run countdown, battery card, read-only crontab preview. Spool
 * paths stay out (per-OS, no endpoint); job rows carry no category
 * field, so search covers filtering. List failures keep the previous
 * render.
 */
export function CronPage(): ReactElement {
  const [running, setRunning] = useState<boolean | null>(null);
  const [daemonPid, setDaemonPid] = useState<number | null>(null);
  const [jobs, setJobs] = useState<CronJobRow[]>([]);
  const [runs, setRuns] = useState<CronRunRow[]>([]);
  const [battery, setBattery] = useState<{ percentage: number; status: string } | null>(null);
  const [preset, setPreset] = useState(PRESETS[0]?.value ?? '* * * * *');
  const [form, setForm] = useState({ name: '', schedule: '', command: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingJob, setPendingJob] = useState<CronJobRow | null>(null);
  const [query, setQuery] = useState('');
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [showCrontab, setShowCrontab] = useState(false);
  const [dryRows, setDryRows] = useState<DryRunRow[] | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async (): Promise<void> => {
    try {
      const daemon = await apiJson<{ running: boolean; pid: number | null }>('/api/cron/daemon');
      setRunning(daemon.running);
      setDaemonPid(daemon.pid);
    } catch {
      // keep previous
    }
    try {
      const body = await apiJson<{ jobs: CronJobRow[] }>('/api/cron/jobs');
      setJobs(body.jobs);
    } catch {
      // keep previous
    }
    try {
      const body = await apiJson<{ runs: CronRunRow[] }>('/api/cron/runs?limit=200');
      setRuns(body.runs);
    } catch {
      // keep previous
    }
    try {
      const body = await apiJson<{ battery: { percentage: number; status: string } | { error: string } }>('/api/stats');
      setBattery('percentage' in body.battery ? body.battery : null);
    } catch {
      // battery card stays hidden
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

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

  const runNow = async (job: CronJobRow): Promise<void> => {
    setNotice('');
    setError('');
    try {
      const body = await apiJson<{ ok?: unknown; run?: { exitCode: number | null; latencyMs: number }; error?: string }>(
        `/api/cron/jobs/${job.id}/run`,
        { method: 'POST' },
      );
      if (body.ok === true && body.run !== undefined) {
        setNotice(`Ran ${job.name}: exit ${body.run.exitCode ?? '?'} in ${body.run.latencyMs}ms`);
      } else setError(typeof body.error === 'string' ? body.error : 'Failed');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const dryRunAll = async (): Promise<void> => {
    setError('');
    try {
      const body = await apiJson<{ results: DryRunRow[] }>('/api/cron/jobs/dry-run', { method: 'POST' });
      setDryRows(body.results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed');
    }
  };

  const copyCommand = async (command: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // clipboard blocked: the command stays visible for manual copy
    }
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

  const nextRuns = jobs.filter((j) => j.enabled && j.nextRun !== null).map((j) => j.nextRun as number);
  const nextIn = nextRuns.length === 0 ? null : Math.min(...nextRuns);
  const dayAgo = nowMs - 24 * 3600 * 1000;
  const dayRuns = runs.filter((r) => r.startedAt >= dayAgo);
  const succeeded = dayRuns.filter((r) => !r.timedOut && r.exitCode === 0).length;
  const avgLatency = dayRuns.length === 0 ? null : Math.round(dayRuns.reduce((s, r) => s + r.latencyMs, 0) / dayRuns.length);
  const lastRunFor = (jobId: string): CronRunRow | undefined => runs.find((r) => r.jobId === jobId);

  return (
    <main className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">Cron</h1>
        <span className="text-xs text-neutral-400">
          {jobs.filter((j) => j.enabled).length} active · {jobs.filter((j) => !j.enabled).length} paused
        </span>
        {nextIn !== null && (
          <Badge tone="info">Next in {fmtUptime(Math.max(0, Math.ceil((nextIn - nowMs) / 1000)))}</Badge>
        )}
        <Button size="sm" variant="outline" onClick={() => setShowCrontab(true)}>
          View crontab
        </Button>
        <Button size="sm" variant="outline" onClick={() => void dryRunAll()}>
          Dry-run all
        </Button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className={running === true ? 'text-green-400' : 'text-neutral-400'}>
          {running === null ? '…' : running ? 'crond running' : 'crond stopped'}
        </span>
        {daemonPid !== null && <span className="font-mono text-xs text-neutral-400">PID {daemonPid}</span>}
        {battery !== null && (
          <span className="text-xs text-neutral-400">
            Battery {battery.percentage}% · {battery.status}
          </span>
        )}
        <Button size="sm" variant="outline" onClick={() => void service('start')}>
          Start
        </Button>
        <Button size="sm" variant="outline" onClick={() => void service('stop')}>
          Stop
        </Button>
      </div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs text-neutral-400">
        <span>
          24h dispatches: <strong className="text-neutral-200">{dayRuns.length}</strong>
        </span>
        <span>
          Success: <strong className="text-neutral-200">{dayRuns.length === 0 ? '—' : `${Math.round((succeeded / dayRuns.length) * 100)}%`}</strong>
        </span>
        <span>
          Avg latency: <strong className="text-neutral-200">{avgLatency === null ? '—' : `${avgLatency}ms`}</strong>
        </span>
        <span className="text-neutral-500">(panel-triggered runs only)</span>
      </div>
      {error !== '' && (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {error}
        </p>
      )}
      {notice !== '' && <p className="mb-2 text-sm text-emerald-400">{notice}</p>}
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
      {visible.length === 0 ? (
        <p className="text-sm text-neutral-400">{jobs.length === 0 ? 'No jobs yet' : 'No matches'}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((job) => {
            const last = lastRunFor(job.id);
            return (
              <Card key={job.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-auto font-semibold">{job.name}</span>
                  <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs text-emerald-300">{job.schedule}</code>
                  <span className={job.enabled ? 'text-xs text-green-400' : 'text-xs text-neutral-500'}>
                    {job.enabled ? 'Enabled' : 'Stopped'}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1 font-mono text-xs text-neutral-300">
                    $ {job.command}
                  </code>
                  <Button size="sm" variant="ghost" onClick={() => void copyCommand(job.command)}>
                    Copy
                  </Button>
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  Next: {job.nextRun === null ? '—' : fmtDate(job.nextRun)}
                  {last !== undefined && ` · Last run: exit ${last.exitCode ?? '?'} (${last.latencyMs}ms)`}
                </p>
                <div className="mt-2 flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => void runNow(job)}>
                    Run now
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void toggle(job.id)}>
                    {job.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => void remove(job)}>
                    Delete
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <ConfirmDialog
        open={pendingJob !== null}
        title="Delete cron job"
        message={pendingJob === null ? '' : `Delete cron job "${pendingJob.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive={true}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingJob(null)}
      />
      {dryRows !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-2 font-bold">Dry-run results</h2>
            <ul className="flex max-h-96 flex-col gap-1 overflow-auto text-sm">
              {dryRows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 px-2 py-1">
                  <span className="mr-auto font-medium">{row.name}</span>
                  {row.ok ? (
                    <Badge tone="success">OK{row.nextRun !== null ? ` · ${fmtDate(row.nextRun)}` : ''}</Badge>
                  ) : (
                    <Badge tone="danger">{row.error ?? 'Failed'}</Badge>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => setDryRows(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
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
