import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { EnvId } from '@olp/env-core';
import { CATALOG, checkCommand, installCommand, itemById } from '@olp/pkgman';
import { defaultExec } from './exec.js';

/** Live install state (log ring capped, Terwo parity). */
export interface InstallRun {
  logs: string[];
  running: boolean;
  exitCode: number | null;
}

/** Max retained log lines per run (Terwo parity). */
const LOG_RING = 500;

/** Shell launcher (tests inject fakes; production spawns `bash -c`). */
export type SpawnShell = (
  cmd: string,
  cwd: string,
  onData: (chunk: string) => void,
  onDone: (code: number | null, err: Error | null) => void,
) => { kill(): void };

/** Production `bash -c` launcher. */
export function realSpawnShell(
  cmd: string,
  cwd: string,
  onData: (chunk: string) => void,
  onDone: (code: number | null, err: Error | null) => void,
): { kill(): void } {
  const child = spawn('bash', ['-c', cmd], { cwd });
  const emit = (data: unknown): void => {
    onData(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  };
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);
  child.on('exit', (code) => onDone(code, null));
  child.on('error', (err) => onDone(null, err));
  return {
    kill: () => {
      try {
        child.kill();
      } catch {
        // never throw from lifecycle calls
      }
    },
  };
}

/** Inputs for {@link registerStoreRoutes}. */
export interface StoreOptions {
  env: EnvId;
  home: string;
  /** Presence probe (8 s, false on error). Defaults to `defaultExec`-backed. */
  check?: (cmd: string) => Promise<boolean>;
  spawnShell?: SpawnShell;
  /** Finish notifier (telegram hook; absent until the telegram spec lands). */
  notify?: (text: string) => void;
}

/**
 * Register Store endpoints (all behind the session gate).
 * Unknown ids and busy runs answer 400; never-run logs answer the
 * empty shape (Terwo parity, no 404s here).
 */
export function registerStoreRoutes(app: FastifyInstance, opts: StoreOptions): void {
  const check = opts.check ?? ((cmd) => defaultExec(cmd, 8000).then(
    () => true,
    () => false,
  ));
  const spawnShell = opts.spawnShell ?? realSpawnShell;
  const runs = new Map<string, InstallRun>();

  const push = (run: InstallRun, line: string): void => {
    run.logs.push(line);
    if (run.logs.length > LOG_RING) run.logs.splice(0, run.logs.length - LOG_RING);
  };

  app.get('/api/install', async () => {
    const items = [];
    for (const item of CATALOG) {
      const probe = checkCommand(item, opts.env);
      // Probes never fail the listing (Terwo execCheck parity: errors count as absent).
      const installed = probe === null ? true : await check(probe).catch(() => false);
      const rec = runs.get(item.id);
      items.push({
        id: item.id,
        name: item.name,
        desc: item.desc,
        installed,
        installing: rec !== undefined && rec.running,
      });
    }
    return { items };
  });

  app.post('/api/install/:id/start', async (req) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const item = itemById(id);
    if (item === undefined) throw new Error('Unknown package');
    const rec = runs.get(id);
    if (rec !== undefined && rec.running) throw new Error('Installation already running');
    const resolved = installCommand(item, opts.env);
    if (!resolved.ok) throw new Error(resolved.reason);
    const run: InstallRun = { logs: [], running: true, exitCode: null };
    runs.set(id, run);
    push(run, `$ ${resolved.cmd}\n`);
    spawnShell(
      resolved.cmd,
      opts.home,
      (chunk) => push(run, chunk),
      (code, err) => {
        run.running = false;
        if (err !== null) {
          run.exitCode = -1;
          push(run, `\n--- failed: ${err.message} ---\n`);
          return;
        }
        run.exitCode = code;
        push(run, `\n--- finished (exit ${String(code)}) ---\n`);
        opts.notify?.(`${code === 0 ? '✅' : '❌'} Install ${item.name} finished (exit ${String(code)})`);
      },
    );
    return { ok: true };
  });

  app.get('/api/install/:id/log', async (req) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const rec = runs.get(id);
    if (rec === undefined) return { logs: '', running: false, exitCode: null };
    return { logs: rec.logs.join(''), running: rec.running, exitCode: rec.exitCode };
  });
}
