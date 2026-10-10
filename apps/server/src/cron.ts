import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { defaultExec } from './exec.js';

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
}

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
    const jobs: CronJob[] = [];
    for (const line of await backend.readLines()) {
      const job = parseCronLine(line);
      if (job !== null) jobs.push(job);
    }
    return { jobs };
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
}
