import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { EnvId, PkgManId } from '@olp/env-core';
import { CATALOG, checkCommand, installCommand, itemById, updateCommand, upgradeCommand, versionCommand } from '@olp/pkgman';
import { defaultExec } from './exec.js';

/** Live install state (log ring capped, Terwo parity). */
export interface InstallRun {
  logs: string[];
  running: boolean;
  exitCode: number | null;
}

/** Max retained log lines per run (Terwo parity). */
const LOG_RING = 500;

/** Presence/version probe timeout (existing 8 s parity). */
const PROBE_TIMEOUT_MS = 8000;

/** Version first-line cap (display-only, never executed). */
const VERSION_LINE_MAX = 120;

/** Mirror latency timeout (slow DNS answers as null, never hangs). */
const DNS_TIMEOUT_MS = 3000;

/** Hostnames parsed from sources files must match this before lookup. */
const HOST_RE = /^[a-z0-9.-]+$/i;

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
  /** Package-manager id (from env detection; `none` → honest nulls). */
  manager: PkgManId;
  home: string;
  /** `$PREFIX` for Termux mirror parsing (tests inject tmp; prod passes env). */
  prefix?: string;
  /** Presence probe (8 s, false on error). Defaults to `defaultExec`-backed. */
  check?: (cmd: string) => Promise<boolean>;
  /** Stdout probe for versions (8 s, rejects on error). Defaults to `defaultExec`-backed. */
  exec?: (cmd: string) => Promise<string>;
  spawnShell?: SpawnShell;
  /** Sources-list reader (null on missing/unreadable). Defaults to fs. */
  readSourceFile?: (path: string) => string | null;
  /** Host resolver for latency (rejects on failure). Defaults to `node:dns`. */
  dnsLookup?: (host: string) => Promise<unknown>;
  /** Finish notifier (telegram hook; absent until the telegram spec lands). */
  notify?: (text: string) => void;
}

/**
 * First mirror host parsed from an APT sources list (`deb` lines only).
 * Untrusted file content: only plausible hostnames are returned (must
 * contain a dot or colon, so degenerate tokens like `https://exa`
 * from a space-broken line never become a displayed mirror).
 */
export function parseMirrorHost(sources: string): string | null {
  for (const line of sources.split('\n')) {
    const url = line.trim().match(/^deb\s+(\S+)/)?.[1];
    if (url === undefined) continue;
    try {
      const host = new URL(url).hostname;
      if (host !== '' && HOST_RE.test(host) && (host.includes('.') || host.includes(':'))) return host;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Register Store endpoints (all behind the session gate).
 * Unknown ids and busy runs answer 400; never-run logs answer the
 * empty shape (Terwo parity, no 404s here). Explicit `/update`,
 * `/upgrade`, `/versions`, and `/mirror` routes are registered before
 * the parametric `:id` routes so manager ops never collide with
 * package ids (plus a test proving it).
 */
export function registerStoreRoutes(app: FastifyInstance, opts: StoreOptions): void {
  const check = opts.check ?? ((cmd) => defaultExec(cmd, PROBE_TIMEOUT_MS).then(
    () => true,
    () => false,
  ));
  const exec = opts.exec ?? ((cmd) => defaultExec(cmd, PROBE_TIMEOUT_MS));
  const spawnShell = opts.spawnShell ?? realSpawnShell;
  const readSourceFile = opts.readSourceFile ?? ((path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  });
  const dnsLookup = opts.dnsLookup ?? ((host) => lookup(host));
  const runs = new Map<string, InstallRun>();
  const ops = new Map<string, InstallRun>();

  const push = (run: InstallRun, line: string): void => {
    run.logs.push(line);
    if (run.logs.length > LOG_RING) run.logs.splice(0, run.logs.length - LOG_RING);
  };

  const readLog = (map: Map<string, InstallRun>, key: string): { logs: string; running: boolean; exitCode: number | null } => {
    const rec = map.get(key);
    if (rec === undefined) return { logs: '', running: false, exitCode: null };
    return { logs: rec.logs.join(''), running: rec.running, exitCode: rec.exitCode };
  };

  /** Launch a command into a run slot (installs + manager ops share this). */
  const launch = (map: Map<string, InstallRun>, key: string, title: string, cmd: string): void => {
    const run: InstallRun = { logs: [], running: true, exitCode: null };
    map.set(key, run);
    push(run, `$ ${cmd}\n`);
    spawnShell(
      cmd,
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
        opts.notify?.(`${code === 0 ? '✅' : '❌'} ${title} finished (exit ${String(code)})`);
      },
    );
  };

  app.get('/api/install/versions', async () => {
    const entries = await Promise.all(
      CATALOG.map(async (item): Promise<readonly [string, string | null]> => {
        const probe = checkCommand(item, opts.env);
        // Versions only mean something for installed items: skip the
        // version spawn entirely when the presence probe says absent.
        if (probe !== null && !(await check(probe).catch(() => false))) return [item.id, null] as const;
        const vcmd = versionCommand(item);
        if (vcmd === null) return [item.id, null] as const;
        try {
          const first = (await exec(vcmd)).split('\n')[0]?.trim() ?? '';
          return [item.id, first === '' ? null : first.slice(0, VERSION_LINE_MAX)] as const;
        } catch {
          return [item.id, null] as const;
        }
      }),
    );
    return { versions: Object.fromEntries(entries) };
  });

  app.post('/api/install/update/start', async () => {
    if (ops.get('update')?.running === true) throw new Error('Repo update already running');
    const resolved = updateCommand(opts.env);
    if (!resolved.ok) throw new Error(resolved.reason);
    launch(ops, 'update', 'Repo update', resolved.cmd);
    return { ok: true };
  });

  app.get('/api/install/update/log', async () => readLog(ops, 'update'));

  app.post('/api/install/upgrade/start', async () => {
    if (ops.get('upgrade')?.running === true) throw new Error('Batch upgrade already running');
    const resolved = upgradeCommand(opts.env);
    if (!resolved.ok) throw new Error(resolved.reason);
    launch(ops, 'upgrade', 'Batch upgrade', resolved.cmd);
    return { ok: true };
  });

  app.get('/api/install/upgrade/log', async () => readLog(ops, 'upgrade'));

  app.get('/api/install/mirror', async () => {
    const manager = opts.manager === 'none' ? null : opts.manager;
    if (opts.env !== 'termux' || manager === null) return { manager, mirror: null, latencyMs: null };
    const prefix = opts.prefix ?? process.env['PREFIX'] ?? '';
    const raw = prefix === '' ? null : readSourceFile(join(prefix, 'etc/apt/sources.list'));
    const mirror = raw === null ? null : parseMirrorHost(raw);
    if (mirror === null) return { manager, mirror: null, latencyMs: null };
    const started = Date.now();
    const reachable = await Promise.race([
      dnsLookup(mirror).then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DNS_TIMEOUT_MS)),
    ]);
    return { manager, mirror, latencyMs: reachable ? Date.now() - started : null };
  });

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
        conf: item.conf ?? null,
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
    launch(runs, id, `Install ${item.name}`, resolved.cmd);
    return { ok: true };
  });

  app.get('/api/install/:id/log', async (req) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    return readLog(runs, id);
  });
}
