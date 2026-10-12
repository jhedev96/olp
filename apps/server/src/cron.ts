import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { defaultExec } from './exec.js';
import { nextRunMs } from './cron-schedule.js';
import type { RunRecord, RunStore } from './cron-runs.js';
import { fileRunStore, memoryRunStore } from './cron-runs.js';

/** One tagged schedule entry. */
export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
}

/** Crontab backend (real cron in production, memory fakes in tests). */
export interface CronBackend {
  /** `crontab -l` split by newline; absent crontabs resolve `[]`. */
  readLines(): Promise<string[]>;
  /** Replace the whole crontab via `crontab -` stdin. */
  writeLines(lines: string[]): Promise<void>;
  exec(cmd: string, timeoutMs: number): Promise<string>;
  /** Fire-and-forget daemon start (`crond` detached + unrefed). */
  spawnDetached(cmd: string, args: string[]): void;
  hasBin(bin: string): Promise<boolean>;
  /** Run a command with capture (Run Now). Rejects only on spawn failure. */
  runCommand(cmd: string, timeoutMs: number): Promise<RunResult>;
}

/** Captured execution (output capped to the last 8 KB). */
export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  latencyMs: number;
}

/** Run Now bound (documented; kills with SIGTERM past the deadline). */
export const RUN_TIMEOUT_MS = 60000;
/** Output tail kept per run (documented). */
export const RUN_OUTPUT_CAP = 8192;

/** Production backend over `crontab(1)`/`crond(8)` CLIs. */
export function nodeCronBackend(): CronBackend {
  return {
    readLines: async () => {
      try {
        return (await defaultExec('crontab -l', 8000)).split('\n');
      } catch {
        return [];
      }
    },
    writeLines: (lines) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn('bash', ['-c', 'crontab -']);
        let err = '';
        child.stderr?.on('data', (d) => {
          err += Buffer.isBuffer(d) ? d.toString('utf8') : String(d);
        });
        child.on('error', (e) => reject(e));
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`crontab failed: ${err.slice(-300)}`)),
        );
        child.stdin?.write(lines.join('\n') + '\n');
        child.stdin?.end();
      }),
    exec: (cmd, timeoutMs) => defaultExec(cmd, timeoutMs),
    spawnDetached: (cmd, args) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        // start route gates on hasBin; a late failure must not crash the server
      });
      child.unref();
    },
    hasBin: async (bin) => {
      try {
        await defaultExec(`command -v ${bin} >/dev/null 2>&1`, 8000);
        return true;
      } catch {
        return false;
      }
    },
    runCommand: (cmd, timeoutMs) =>
      new Promise<RunResult>((resolve, reject) => {
        const start = Date.now();
        const child = spawn('bash', ['-c', cmd], { timeout: timeoutMs });
        let out = '';
        const push = (d: unknown): void => {
          out += Buffer.isBuffer(d) ? d.toString('utf8') : String(d);
          if (out.length > RUN_OUTPUT_CAP + 512) out = out.slice(-RUN_OUTPUT_CAP);
        };
        child.stdout?.on('data', push);
        child.stderr?.on('data', push);
        child.on('error', (err) => reject(err));
        child.on('close', (code, signal) => {
          resolve({
            exitCode: signal !== null ? null : code,
            timedOut: signal !== null,
            output: out.slice(-RUN_OUTPUT_CAP),
            latencyMs: Date.now() - start,
          });
        });
      }),
  };
}

/**
 * Parse one crontab line into a job when it carries our tag, else `null`.
 * A single leading `#` (with optional whitespace) means disabled.
 * Byte-exact Terwo `cronParseLine` parity.
 */
export function parseCronLine(line: string): CronJob | null {
  let enabled = true;
  let text = line;
  if (text.trimStart().startsWith('#')) {
    enabled = false;
    text = text.replace(/^(\s*)#/, '$1');
  }
  const match = text.match(/#\s*panel:([0-9a-f]+):(.*)$/);
  if (match === null || match[1] === undefined) return null;
  const head = text
    .slice(0, match.index)
    .trim()
    .split(/\s+/);
  if (head.length < 6) return null;
  return {
    id: match[1],
    name: (match[2] ?? '').trim(),
    schedule: head.slice(0, 5).join(' '),
    command: head.slice(5).join(' '),
    enabled,
  };
}

/** Render a job back to its tagged line (name sanitized, Terwo parity). */
export function cronJobLine(job: Pick<CronJob, 'schedule' | 'command' | 'id' | 'name'>): string {
  return `${job.schedule} ${job.command} # panel:${job.id}:${job.name.replace(/[\r\n#]/g, ' ')}`;
}

/**
 * Toggle one line when it is tagged with `id`; every other line returns
 * byte-identical (pure helper, Terwo `apiCronToggle` mapping parity).
 */
export function toggleCronLine(line: string, id: string): string {
  const job = parseCronLine(line);
  if (job === null || job.id !== id) return line;
  if (job.enabled) return `#${line}`;
  return line.replace(/^(\s*)#/, '$1');
}

/** Inputs for {@link registerCronRoutes}. */
export interface CronOptions {
  backend: CronBackend;
  /** Run store override (tests pass memory/fakes; default is memory). */
  runs?: RunStore;
  /** File path for persisted runs (production: dataDir; omitted → memory). */
  runsPath?: string;
}

function strField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Register cron scheduler endpoints (all behind the session gate).
 * Thrown errors propagate to the app error handler (400 `{error}`).
 */
export function registerCronRoutes(app: FastifyInstance, opts: CronOptions): void {
  const { backend } = opts;
  const runs: RunStore = opts.runs ?? (opts.runsPath !== undefined ? fileRunStore(opts.runsPath) : memoryRunStore());

  const readJobs = async (): Promise<CronJob[]> => {
    const jobs: CronJob[] = [];
    for (const line of await backend.readLines()) {
      const job = parseCronLine(line);
      if (job !== null) jobs.push(job);
    }
    return jobs;
  };

  app.get('/api/cron/status', async () => {
    try {
      await backend.exec('pgrep -x crond >/dev/null 2>&1', 5000);
      return { running: true };
    } catch {
      return { running: false };
    }
  });

  app.post('/api/cron/service', { bodyLimit: 1024 * 1024 }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const action = strField(body, 'action');
    if (action === 'start') {
      if (!(await backend.hasBin('crond'))) {
        throw new Error('crond is not installed. Install Cronie via the Store menu.');
      }
      backend.spawnDetached('crond', []);
    } else if (action === 'stop') {
      await backend.exec('pkill -x crond', 5000).catch(() => '');
    } else {
      throw new Error('Unknown action');
    }
    return { ok: true };
  });

  app.get('/api/cron/jobs', async () => {
    const now = Date.now();
    return { jobs: (await readJobs()).map((job) => ({ ...job, nextRun: nextRunMs(job.schedule, now) })) };
  });

  app.post('/api/cron/jobs', { bodyLimit: 1024 * 1024 }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const name = strField(body, 'name').trim() === '' ? 'job' : strField(body, 'name').trim();
    const schedule = strField(body, 'schedule').trim();
    const command = strField(body, 'command').trim();
    if (!/^(\S+\s+){4}\S+$/.test(schedule)) throw new Error('Schedule must have 5 cron fields');
    if (command === '') throw new Error('Command is required');
    if (!(await backend.hasBin('crontab'))) throw new Error('crontab is not available on this system');
    const lines = await backend.readLines();
    const job: CronJob = { id: randomBytes(4).toString('hex'), name, schedule, command, enabled: true };
    lines.push(cronJobLine(job));
    await backend.writeLines(lines);
    return { ok: true, job };
  });

  app.post('/api/cron/jobs/:id/toggle', async (req) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    await backend.writeLines((await backend.readLines()).map((line) => toggleCronLine(line, id)));
    return { ok: true };
  });

  app.delete('/api/cron/jobs/:id', async (req) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const kept: string[] = [];
    for (const line of await backend.readLines()) {
      const job = parseCronLine(line);
      if (job === null || job.id !== id) kept.push(line);
    }
    await backend.writeLines(kept);
    return { ok: true };
  });

  app.post('/api/cron/jobs/:id/run', { bodyLimit: 1024 }, async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const job = (await readJobs()).find((j) => j.id === id);
    if (job === undefined) {
      reply.code(404);
      return { error: 'Unknown job' };
    }
    const startedAt = Date.now();
    let result;
    try {
      result = await backend.runCommand(job.command, RUN_TIMEOUT_MS);
    } catch (err) {
      const message = err instanceof Error && err.message !== '' ? err.message : 'Run failed to start';
      reply.code(500);
      return { error: message };
    }
    const record: RunRecord = {
      id: randomBytes(4).toString('hex'),
      jobId: job.id,
      name: job.name,
      command: job.command,
      startedAt,
      finishedAt: Date.now(),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      latencyMs: result.latencyMs,
      output: result.output,
    };
    runs.append(record);
    return { ok: true, run: record };
  });

  app.get('/api/cron/runs', async (req) => {
    const raw = ((req.query ?? {}) as Record<string, unknown>)['limit'];
    const limit = typeof raw === 'string' ? Number.parseInt(raw, 10) : 50;
    return { runs: runs.list(Number.isInteger(limit) ? limit : 50) };
  });

  app.post('/api/cron/jobs/dry-run', async () => {
    const now = Date.now();
    const results = [];
    for (const job of await readJobs()) {
      const next = nextRunMs(job.schedule, now);
      const token = job.command.trim().split(/\s+/).find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) ?? '';
      if (next === null) {
        results.push({ id: job.id, name: job.name, enabled: job.enabled, ok: false, nextRun: null, resolved: false, error: 'Invalid schedule' });
        continue;
      }
      if (token === '') {
        results.push({ id: job.id, name: job.name, enabled: job.enabled, ok: false, nextRun: null, resolved: false, error: 'Empty command' });
        continue;
      }
      const resolved = await backend.hasBin(token);
      results.push({
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        ok: resolved,
        nextRun: next,
        resolved,
        error: resolved ? null : `Command not found: ${token}`,
      });
    }
    return { results };
  });

  app.get('/api/cron/daemon', async () => {
    let running = false;
    try {
      await backend.exec('pgrep -x crond >/dev/null 2>&1', 5000);
      running = true;
    } catch {
      running = false;
    }
    let pid: number | null = null;
    try {
      const out = await backend.exec('pidof crond', 5000);
      const first = out.trim().split(/\s+/)[0] ?? '';
      const n = Number.parseInt(first, 10);
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      pid = null;
    }
    return { running, pid };
  });
}
