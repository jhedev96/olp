import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { EnvId, PkgManId } from '@olp/env-core';
import {
  CATALOG,
  checkCommand,
  installCommand,
  itemById,
  mirrorSource,
  parseApkMirror,
  parseAptMirror,
  parseBrewRemote,
  parsePacmanMirror,
  parseYumMirror,
  purgeCommand,
  updateCommand,
  upgradeCommand,
  versionCommand,
} from '@olp/pkgman';
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
  /** Sources-dir lister (empty on missing/unreadable). Defaults to fs. */
  listSourceDir?: (dir: string) => string[];
  /** Host resolver for latency (rejects on failure). Defaults to `node:dns`. */
  dnsLookup?: (host: string) => Promise<unknown>;
  /** Finish notifier (telegram hook; absent until the telegram spec lands). */
  notify?: (text: string) => void;
}

/**
 * First mirror host parsed from an APT sources list (`deb` lines and
 * DEB822 `URIs:`). Untrusted file content: only plausible hostnames
 * are returned (must contain a dot or colon, so degenerate tokens
 * like `https://exa` from a space-broken line never become a
 * displayed mirror). Thin wrapper over the pkgman parser (kept for
 * the Termux-first history; new code calls `parseAptMirror` via the
 * per-env path below).
 */
export function parseMirrorHost(sources: string): string | null {
  return parseAptMirror(sources);
}

/** Brew repo paths must pass this before joining (untrusted exec output). */
function safeRepoPath(path: string): boolean {
  return path !== '' && path.startsWith('/') && !path.includes('..') && !path.includes('\n') && !path.includes("'") && !path.includes('"');
}

/**
 * Register Store endpoints (all behind the session gate).
 * Unknown ids and busy runs answer 400; never-run logs answer the
 * empty shape (Terwo parity, no 404s here). Explicit `/update`,
 * `/upgrade`, `/purge`, `/versions`, and `/mirror` routes are
 * registered before the parametric `:id` routes so manager ops never
 * collide with package ids (plus a test proving it).
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
  const listSourceDir = opts.listSourceDir ?? ((dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
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

  app.post('/api/install/purge/start', async () => {
    if (ops.get('purge')?.running === true) throw new Error('Cache purge already running');
    const resolved = purgeCommand(opts.env);
    if (!resolved.ok) throw new Error(resolved.reason);
    launch(ops, 'purge', 'Cache purge', resolved.cmd);
    return { ok: true };
  });

  app.get('/api/install/purge/log', async () => readLog(ops, 'purge'));

  /** Brew origin host via the repo gitconfig (any failure → null). */
  const brewMirror = async (): Promise<string | null> => {
    try {
      const repo = (await exec('brew --repository')).split('\n')[0]?.trim() ?? '';
      if (!safeRepoPath(repo)) return null;
      const raw = readSourceFile(join(repo, '.git/config'));
      return raw === null ? null : parseBrewRemote(raw);
    } catch {
      return null;
    }
  };

  /** First mirror host across the env's candidate files (first hit wins). */
  const fileMirror = (): string | null => {
    const source = mirrorSource(opts.env);
    if (source === null || source.kind === 'brew') return null;
    const prefix = opts.prefix ?? process.env['PREFIX'] ?? '';
    if (source.underPrefix === true && prefix === '') return null;
    const candidates: string[] = [];
    if (source.file !== undefined) {
      candidates.push(source.underPrefix === true ? join(prefix, source.file) : source.file);
    }
    if (source.dir !== undefined) {
      const dir = source.underPrefix === true ? join(prefix, source.dir) : source.dir;
      for (const entry of listSourceDir(dir).filter((f) => source.ext === undefined || f.endsWith(source.ext)).sort()) {
        candidates.push(join(dir, entry));
      }
    }
    const parse =
      source.kind === 'apt'
        ? parseAptMirror
        : source.kind === 'pacman'
          ? parsePacmanMirror
          : source.kind === 'apk'
            ? parseApkMirror
            : parseYumMirror;
    for (const path of candidates) {
      const raw = readSourceFile(path);
      if (raw === null) continue;
      const host = parse(raw);
      if (host !== null) return host;
    }
    return null;
  };

  app.get('/api/install/mirror', async () => {
    const manager = opts.manager === 'none' ? null : opts.manager;
    const source = mirrorSource(opts.env);
    if (manager === null || source === null) return { manager, mirror: null, latencyMs: null };
    const mirror = source.kind === 'brew' ? await brewMirror() : fileMirror();
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
