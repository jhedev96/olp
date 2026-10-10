import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { defaultExec } from './exec.js';
import { relOf, safePath } from './files.js';

/** Supported site runtimes. */
export type SiteType = 'node' | 'php' | 'static' | 'go';

/** Persisted site record (`sites.json`). */
export interface Site {
  id: string;
  name: string;
  type: SiteType;
  /** Path relative to the file-manager root. */
  path: string;
  port: number;
  created: number;
}

/** Site record plus liveness flag (list endpoint shape). */
export interface SiteStatus extends Site {
  running: boolean;
}

/** Managed child process (never throws from `kill`). */
export interface SiteProcess {
  kill(): void;
  onOutput(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  onError(cb: (err: Error) => void): void;
}

/** Process launcher (tests inject fakes; production spawns real children). */
export interface SiteSpawner {
  spawn(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): SiteProcess;
  /** `command -v` probe for runtime bins. */
  hasBin(bin: string): Promise<boolean>;
}

/** Persisted site registry (`sites.json` in production, memory in tests). */
export interface SiteStore {
  list(): Site[];
  save(sites: Site[]): void;
}

/** File-backed registry in the server data dir (mode `0600`, auth-config parity). */
export function fileSiteStore(dataDir: string): SiteStore {
  const file = join(dataDir, 'sites.json');
  return {
    list: () => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? (parsed as Site[]) : [];
      } catch {
        return [];
      }
    },
    save: (sites) => writeFileSync(file, JSON.stringify(sites, null, 2), { mode: 0o600 }),
  };
}

/** Production spawner over `child_process` (argv arrays only, never shell strings). */
export function realSpawner(): SiteSpawner {
  return {
    hasBin: async (bin) => {
      try {
        await defaultExec(`command -v ${bin} >/dev/null 2>&1`, 8000);
        return true;
      } catch {
        return false;
      }
    },
    spawn: (cmd, args, opts) => {
      const child: ChildProcess = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
      let outputCb: (chunk: string) => void = () => {};
      let exitCb: (code: number | null) => void = () => {};
      let errorCb: (err: Error) => void = () => {};
      const emit = (data: unknown): void => {
        outputCb(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
      };
      child.stdout?.on('data', emit);
      child.stderr?.on('data', emit);
      child.on('exit', (code) => exitCb(code));
      child.on('error', (err) => errorCb(err));
      return {
        kill: () => {
          try {
            child.kill();
          } catch {
            // never throw from lifecycle calls
          }
        },
        onOutput: (cb) => {
          outputCb = cb;
        },
        onExit: (cb) => {
          exitCb = cb;
        },
        onError: (cb) => {
          errorCb = cb;
        },
      };
    },
  };
}

/** Max retained log lines per site (Terwo parity). */
const LOG_RING = 300;
/** Grace between kill and start on restart (Terwo parity). */
const RESTART_GRACE_MS = 500;

interface Running {
  proc: SiteProcess;
  logs: string[];
  started: number;
}

/** Inputs for {@link registerSitesRoutes}. */
export interface SitesOptions {
  root: string;
  store: SiteStore;
  spawner: SiteSpawner;
}

function strField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function isSiteType(value: unknown): value is SiteType {
  return value === 'node' || value === 'php' || value === 'static' || value === 'go';
}

/**
 * Register website-hosting endpoints (all behind the session gate).
 * Unknown ids answer 404; validation failures throw to the app
 * error handler (400 `{error}`, Terwo parity).
 */
export function registerSitesRoutes(app: FastifyInstance, opts: SitesOptions): void {
  const running = new Map<string, Running>();
  const deadLogs = new Map<string, string>();

  const findSite = (id: string): Site | undefined => opts.store.list().find((s) => s.id === id);

  const pushLog = (id: string, line: string): void => {
    const rec = running.get(id);
    if (rec === undefined) return;
    rec.logs.push(line);
    if (rec.logs.length > LOG_RING) rec.logs.splice(0, rec.logs.length - LOG_RING);
  };

  const finish = (id: string): void => {
    const rec = running.get(id);
    if (rec !== undefined) deadLogs.set(id, rec.logs.join(''));
    running.delete(id);
  };

  const notFound = async (reply: import('fastify').FastifyReply): Promise<{ error: string }> => {
    reply.code(404);
    return { error: 'Website not found' };
  };

  const startSite = async (site: Site): Promise<void> => {
    if (running.has(site.id)) throw new Error('Already running');
    if (site.type === 'static' && !(await opts.spawner.hasBin('python3'))) {
      throw new Error('Install python first via the Store menu');
    }
    if (site.type === 'go' && !(await opts.spawner.hasBin('go'))) {
      throw new Error('Install Go first via the Store menu');
    }
    const full = safePath(opts.root, site.path);
    const baseEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(site.port) };
    let proc: SiteProcess;
    if (site.type === 'node') {
      proc = opts.spawner.spawn('node', [full], { cwd: dirname(full), env: baseEnv });
    } else if (site.type === 'php') {
      proc = opts.spawner.spawn('php', ['-S', `127.0.0.1:${site.port}`, '-t', full], {
        cwd: full,
        env: { ...process.env },
      });
    } else if (site.type === 'static') {
      proc = opts.spawner.spawn(
        'python3',
        ['-m', 'http.server', String(site.port), '--directory', full],
        { cwd: full, env: baseEnv },
      );
    } else {
      proc = opts.spawner.spawn('go', ['run', '.'], { cwd: full, env: baseEnv });
    }
    running.set(site.id, { proc, logs: [], started: Date.now() });
    deadLogs.delete(site.id);
    pushLog(site.id, `--- start (${site.type}) port ${site.port} ---\n`);
    proc.onOutput((chunk) => pushLog(site.id, chunk));
    proc.onExit((code) => {
      pushLog(site.id, `--- stopped (exit ${String(code)}) ---\n`);
      finish(site.id);
    });
    proc.onError((err) => {
      pushLog(site.id, `--- failed to start: ${err.message} ---\n`);
      finish(site.id);
    });
  };

  app.get('/api/sites', async () => ({
    sites: opts.store.list().map((site) => ({ ...site, running: running.has(site.id) })),
  }));

  app.post('/api/sites', { bodyLimit: 1024 * 1024 }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const name = strField(body, 'name').trim();
    if (name === '') throw new Error('Name is required');
    if (!isSiteType(body['type'])) throw new Error('Type must be nodejs, php, static, or go');
    const port = Number.parseInt(typeof body['port'] === 'string' || typeof body['port'] === 'number' ? String(body['port']) : '', 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('Port must be 1024–65535');
    }
    if (opts.store.list().some((s) => s.port === port)) {
      throw new Error('Port is already used by another website');
    }
    const full = safePath(opts.root, strField(body, 'path'));
    const st = await fsp.stat(full).catch(() => null);
    if (st === null) throw new Error('Path not found');
    if (body['type'] === 'node' && !st.isFile()) {
      throw new Error('For Node.js, path must be a file (e.g. server.js)');
    }
    if (body['type'] === 'php' && !st.isDirectory()) {
      throw new Error('For PHP, path must be a document root folder');
    }
    if (body['type'] === 'static' && !st.isDirectory()) {
      throw new Error('For Static, path must be a folder');
    }
    if (body['type'] === 'go' && !st.isDirectory()) {
      throw new Error('For Go, path must be a project folder');
    }
    const site: Site = {
      id: randomBytes(8).toString('hex'),
      name,
      type: body['type'],
      path: relOf(opts.root, full),
      port,
      created: Date.now(),
    };
    const sites = opts.store.list();
    sites.push(site);
    opts.store.save(sites);
    return { ok: true, site };
  });

  for (const action of ['start', 'stop', 'restart', 'delete'] as const) {
    app.post(`/api/sites/:id/${action}`, async (req, reply) => {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const id = typeof params['id'] === 'string' ? params['id'] : '';
      const site = findSite(id);
      if (site === undefined) return notFound(reply);
      if (action === 'start') {
        await startSite(site);
        return { ok: true };
      }
      if (action === 'stop') {
        const rec = running.get(site.id);
        if (rec === undefined) throw new Error('Not running');
        try {
          rec.proc.kill();
        } catch {
          // ignore kill errors on stop
        }
        running.delete(site.id);
        return { ok: true };
      }
      if (action === 'restart') {
        const rec = running.get(site.id);
        if (rec !== undefined) {
          try {
            rec.proc.kill();
          } catch {
            // ignore kill errors on restart
          }
          running.delete(site.id);
          await new Promise((r) => setTimeout(r, RESTART_GRACE_MS));
        }
        await startSite(site);
        return { ok: true };
      }
      const rec = running.get(site.id);
      if (rec !== undefined) {
        try {
          rec.proc.kill();
        } catch {
          // ignore kill errors on delete
        }
        running.delete(site.id);
      }
      opts.store.save(opts.store.list().filter((s) => s.id !== site.id));
      deadLogs.delete(site.id);
      return { ok: true };
    });
  }

  app.get('/api/sites/:id/logs', async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    if (findSite(id) === undefined) return notFound(reply);
    const rec = running.get(id);
    if (rec !== undefined) return { logs: rec.logs.join(''), running: true };
    return { logs: deadLogs.get(id) ?? '', running: false };
  });
}
