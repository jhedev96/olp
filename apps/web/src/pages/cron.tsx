import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, apiJson } from '../lib/api.js';
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
 * Cron scheduler (Terwo cron-tab parity): daemon status + start/stop,
 * preset-driven add form, jobs table with enable/disable + delete
 * (confirm-gated). List failures keep the previous render.
 */
export function CronPage(): ReactElement {
  const [running, setRunning] = useState<boolean | null>(null);
  const [jobs, setJobs] = useState<CronJobRow[]>([]);
  const [preset, setPreset] = useState(PRESETS[0]?.value ?? '* * * * *');
  const [form, setForm] = useState({ name: '', schedule: '', command: '' });
  const [error, setError] = useState('');

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

  const remove = async (job: CronJobRow): Promise<void> => {
    if (!window.confirm(`Delete cron job "${job.name}"? This cannot be undone.`)) return;
    await apiJson(`/api/cron/jobs/${job.id}`, { method: 'DELETE' }).catch(() => undefined);
    await load();
  };

  return (
    <main className="p-4">
      <h1 className="mb-4 text-xl font-bold">Cron</h1>
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
      </div>
      <Card className="p-0">
        <table className="w-full text-sm">
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td className="text-neutral-400">No jobs yet</td>
              </tr>
            ) : (
              jobs.map((job) => (
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
    </main>
  );
}
