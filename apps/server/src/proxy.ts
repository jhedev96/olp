import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { defaultExec } from './exec.js';

/** Persisted reverse-proxy record (`nginx.json`). */
export interface Proxy {
  id: string;
  name: string;
  listenPort: number;
  domain: string;
  targetPort: number;
  created: number;
}

/** Persisted proxy registry (`nginx.json` in production, memory in tests). */
export interface ProxyStore {
  list(): Proxy[];
  save(proxies: Proxy[]): void;
}

/** Injected OS surface (real fs/exec in production, memory fakes in tests). */
export interface ProxySystem {
  exec(cmd: string, timeoutMs: number): Promise<string>;
  readFile(path: string): string | null;
  writeFile(path: string, data: string): void;
  mkdirp(dir: string): void;
  listDir(dir: string): string[];
  removeFile(path: string): void;
}

/** Inputs for {@link registerProxyRoutes}. */
export interface ProxyOptions {
  dataDir: string;
  sitesDir: string;
  /** Termux `$PREFIX` or `''` on other systems (drives `nginx.conf` lookup). */
  prefix: string;
  store: ProxyStore;
  sys: ProxySystem;
}

/** File-backed registry in the server data dir (mode `0600`). */
export function fileProxyStore(dataDir: string): ProxyStore {
  const file = join(dataDir, 'nginx.json');
  return {
    list: () => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        const proxies = (typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)['proxies']
          : undefined) as unknown;
        return Array.isArray(proxies) ? (proxies as Proxy[]) : [];
      } catch {
        return [];
      }
    },
    save: (proxies) =>
      writeFileSync(file, JSON.stringify({ proxies }, null, 2), { mode: 0o600 }),
  };
}

/** Production system surface (real fs + `defaultExec`). */
export function nodeProxySys(): ProxySystem {
  return {
    exec: (cmd, timeoutMs) => defaultExec(cmd, timeoutMs),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile: (path, data) => writeFileSync(path, data, 'utf8'),
    mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
    listDir: (dir) => readdirSync(dir),
    removeFile: (path) => unlinkSync(path),
  };
}

/**
 * Resolve the system `nginx.conf` path: `<prefix>/etc/nginx/nginx.conf`
 * on Termux, `/etc/nginx/nginx.conf` elsewhere.
 */
export function nginxConfPath(prefix: string): string {
  return `${prefix === '' ? '/etc' : `${prefix}/etc`}/nginx/nginx.conf`;
}

/**
 * Render a `server {}` block (byte-shape parity with Terwo).
 * `domain` empty renders `server_name _;`.
 */
export function nginxConfBlock(proxy: Pick<Proxy, 'listenPort' | 'domain' | 'targetPort'>): string {
  return (
    'server {\n' +
    `    listen ${proxy.listenPort};\n` +
    `    server_name ${proxy.domain === '' ? '_' : proxy.domain};\n` +
    '    location / {\n' +
    `        proxy_pass http://127.0.0.1:${proxy.targetPort};\n` +
    '        proxy_set_header Host $host;\n' +
    '        proxy_set_header X-Real-IP $remote_addr;\n' +
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n' +
    '    }\n}\n'
  );
}

/**
 * Insert `include <sitesDir>/*.conf;` as the last line of the `http {}`
 * block. No-op when already present (idempotent).
 *
 * @throws `http block not found in nginx.conf` / `nginx.conf damaged
 * (unbalanced braces)` on malformed input.
 */
export function patchNginxInclude(confText: string, sitesDir: string): string {
  if (confText.includes(sitesDir)) return confText;
  const httpAt = confText.indexOf('http {');
  if (httpAt === -1) throw new Error('http block not found in nginx.conf');
  let depth = 0;
  let i = confText.indexOf('{', httpAt);
  for (; i < confText.length; i++) {
    const ch = confText[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error('nginx.conf damaged (unbalanced braces)');
  return `${confText.slice(0, i)}    include ${sitesDir}/*.conf;\n${confText.slice(i)}`;
}

function tail(text: string): string {
  return text.slice(-500);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Require a helper binary, with the Store-install hint on absence. */
async function mustBin(sys: ProxySystem, bin: 'nginx'): Promise<void> {
  try {
    await sys.exec(`command -v ${bin} >/dev/null 2>&1`, 8000);
  } catch {
    throw new Error(`Package "${bin}" is not installed — install it first via the Store menu`);
  }
}

/**
 * Rewrite all panel confs + include line, gated by `nginx -t`.
 * Throws the config-test tail on failure (caller rolls back).
 */
async function writeAll(opts: ProxyOptions): Promise<void> {
  const { sys } = opts;
  sys.mkdirp(opts.sitesDir);
  for (const file of sys.listDir(opts.sitesDir)) {
    if (file.startsWith('panel-') && file.endsWith('.conf')) sys.removeFile(join(opts.sitesDir, file));
  }
  for (const proxy of opts.store.list()) {
    sys.writeFile(join(opts.sitesDir, `panel-${proxy.id}.conf`), nginxConfBlock(proxy));
  }
  const confPath = nginxConfPath(opts.prefix);
  const confText = sys.readFile(confPath);
  if (confText === null) {
    throw new Error('nginx.conf not found. Install nginx first via the Store menu.');
  }
  const patched = patchNginxInclude(confText, opts.sitesDir);
  if (patched !== confText) sys.writeFile(confPath, patched);
  try {
    await sys.exec('nginx -t', 15000);
  } catch (err) {
    throw new Error(`nginx -t failed: ${tail(errText(err))}`);
  }
}

/** Best-effort reload (nginx may simply not be running — Terwo parity). */
async function tryReload(sys: ProxySystem): Promise<void> {
  try {
    await sys.exec('nginx -s reload', 10000);
  } catch {
    // ignore: absence of a running nginx is not an error here
  }
}

function strField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function parsePort(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  return Number.parseInt(String(value), 10);
}

/**
 * Register nginx status/service/proxy endpoints (all behind the session gate).
 * Thrown errors propagate to the app error handler (400 `{error}`).
 */
export function registerProxyRoutes(app: FastifyInstance, opts: ProxyOptions): void {
  app.get('/api/nginx/status', async () => {
    try {
      await opts.sys.exec('pgrep -x nginx >/dev/null 2>&1', 5000);
      return { running: true };
    } catch {
      return { running: false };
    }
  });

  app.post('/api/nginx/service', { bodyLimit: 1024 * 1024 }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const action = strField(body, 'action');
    if (action === 'start') {
      await mustBin(opts.sys, 'nginx');
      try {
        await opts.sys.exec('nginx', 10000);
      } catch (err) {
        throw new Error(`Failed to start nginx: ${tail(errText(err))}`);
      }
    } else if (action === 'stop') {
      try {
        await opts.sys.exec('nginx -s stop', 10000);
      } catch (err) {
        throw new Error(`Failed to stop nginx: ${tail(errText(err))}`);
      }
    } else if (action === 'reload') {
      await mustBin(opts.sys, 'nginx');
      try {
        await opts.sys.exec('nginx -t', 15000);
      } catch (err) {
        throw new Error(`nginx -t failed: ${tail(errText(err))}`);
      }
      await opts.sys.exec('nginx -s reload', 10000).catch(() => '');
    } else {
      throw new Error('Unknown action');
    }
    return { ok: true };
  });

  app.get('/api/nginx/proxies', async () => ({ proxies: opts.store.list() }));

  app.post('/api/nginx/proxies', { bodyLimit: 1024 * 1024 }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const name = strField(body, 'name').trim();
    if (name === '') throw new Error('Name is required');
    const listenPort = parsePort(body['listenPort']);
    if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
      throw new Error('Listen port must be 1024-65535 (Termux cannot bind <1024 without root)');
    }
    const targetPort = parsePort(body['targetPort']);
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      throw new Error('Invalid target port');
    }
    const domain = strField(body, 'domain').trim();
    if (domain !== '' && !/^[a-zA-Z0-9.*_-]+$/.test(domain)) throw new Error('Invalid domain');
    if (opts.store.list().some((p) => p.listenPort === listenPort)) {
      throw new Error('Listen port is already used by another proxy');
    }
    const proxy: Proxy = {
      id: randomBytes(4).toString('hex'),
      name,
      listenPort,
      domain,
      targetPort,
      created: Date.now(),
    };
    const proxies = opts.store.list();
    proxies.push(proxy);
    opts.store.save(proxies);
    try {
      await writeAll(opts);
    } catch (err) {
      opts.store.save(opts.store.list().filter((p) => p.id !== proxy.id));
      throw err;
    }
    await tryReload(opts.sys);
    return { ok: true, proxy };
  });

  app.delete('/api/nginx/proxies/:id', async (req) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    opts.store.save(opts.store.list().filter((p) => p.id !== id));
    try {
      await writeAll(opts);
    } catch {
      // ignore: conf already deleted, registry is the source of truth
    }
    await tryReload(opts.sys);
    return { ok: true };
  });
}
