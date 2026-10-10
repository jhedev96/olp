import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { nginxConfBlock, patchNginxInclude } from '../src/proxy.js';
import type { Proxy, ProxySystem } from '../src/proxy.js';

const KNOWN_PASSWORD = 'proxypass1';

const fakeEnv: Environment = {
  id: 'debian',
  prettyName: 'Debian 12',
  pkgman: 'apt',
  service: 'systemd',
  isWsl: false,
  libc: 'glibc',
  prefix: '',
  shell: 'sh',
  pathExtra: [],
};

const NGINX_CONF = 'events {}\nhttp {\n    server {\n        listen 80;\n    }\n}\n';

function makeSys(opts: {
  pgrepOk?: boolean;
  haveNginx?: boolean;
  testOk?: boolean;
  startOk?: boolean;
  stopOk?: boolean;
  conf?: string | null;
} = {}): { sys: ProxySystem; files: Map<string, string>; commands: string[] } {
  const files = new Map<string, string>();
  if (opts.conf !== undefined && opts.conf !== null) files.set('/etc/nginx/nginx.conf', opts.conf);
  const commands: string[] = [];
  const sys: ProxySystem = {
    exec: (cmd) => {
      commands.push(cmd);
      if (cmd.startsWith('pgrep')) {
        return (opts.pgrepOk ?? false) ? Promise.resolve('') : Promise.reject(new Error('no match'));
      }
      if (cmd.startsWith('command -v')) {
        return (opts.haveNginx ?? true) ? Promise.resolve('/usr/sbin/nginx\n') : Promise.reject(new Error('not found'));
      }
      if (cmd === 'nginx -t') {
        return (opts.testOk ?? true) ? Promise.resolve('ok\n') : Promise.reject(new Error('emerg: bad directive'));
      }
      if (cmd === 'nginx') {
        return (opts.startOk ?? true) ? Promise.resolve('') : Promise.reject(new Error('bind() failed'));
      }
      if (cmd === 'nginx -s stop') {
        return (opts.stopOk ?? true) ? Promise.resolve('') : Promise.reject(new Error('open() failed'));
      }
      if (cmd === 'nginx -s reload') return Promise.resolve('');
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    },
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, data) => {
      files.set(path, data);
    },
    mkdirp: () => {},
    listDir: (dir) =>
      [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    removeFile: (path) => {
      files.delete(path);
    },
  };
  return { sys, files, commands };
}

function memoryStore(): { store: { list(): Proxy[]; save(p: Proxy[]): void }; all(): Proxy[] } {
  let proxies: Proxy[] = [];
  return {
    store: {
      list: () => [...proxies],
      save: (next) => {
        proxies = [...next];
      },
    },
    all: () => [...proxies],
  };
}

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'proxy-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-proxy-'));
  const dataDir = join(base, 'data');
  const legacyDir = join(base, 'legacy');
  const root = join(base, 'root');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      username: 'tester',
      salt: '0'.repeat(32),
      hash: hashPassword(KNOWN_PASSWORD, '0'.repeat(32)),
    }),
  );
  return { dataDir, legacyDir, root };
}

async function authedCookie(app: FastifyInstance): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'tester', password: KNOWN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const raw = login.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : (raw as string);
  return (first ?? '').split(';')[0] ?? '';
}

function testServer(sys: ProxySystem, store: { list(): Proxy[]; save(p: Proxy[]): void }) {
  const { dataDir, legacyDir, root } = freshWorkspace();
  const { app } = buildServer({
    dataDir,
    legacyDir,
    env: fakeEnv,
    sysDeps: quietDeps(),
    root,
    proxyStore: store,
    proxySys: sys,
  });
  return { app, sitesDir: join(dataDir, 'nginx', 'sites') };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('proxy pure helpers', () => {
  it('renders the conf block byte-exact', () => {
    expect(nginxConfBlock({ listenPort: 8080, domain: 'example.com', targetPort: 3000 })).toBe(
      'server {\n' +
        '    listen 8080;\n' +
        '    server_name example.com;\n' +
        '    location / {\n' +
        '        proxy_pass http://127.0.0.1:3000;\n' +
        '        proxy_set_header Host $host;\n' +
        '        proxy_set_header X-Real-IP $remote_addr;\n' +
        '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n' +
        '    }\n}\n',
    );
    expect(nginxConfBlock({ listenPort: 1, domain: '', targetPort: 2 })).toContain('server_name _;');
  });

  it('patches the include line idempotently', () => {
    const dir = '/data/nginx/sites';
    const once = patchNginxInclude(NGINX_CONF, dir);
    expect(once).toContain(`    include ${dir}/*.conf;\n}`);
    expect(patchNginxInclude(once, dir)).toBe(once);
  });

  it('rejects malformed nginx.conf', () => {
    expect(() => patchNginxInclude('events {}\n', '/data/nginx/sites')).toThrow(/http block not found/);
    expect(() => patchNginxInclude('http {\n  server {\n', '/data/nginx/sites')).toThrow(/unbalanced braces/);
  });
});

describe('server proxy routes', () => {
  it('gates status and proxies with 401', async () => {
    const { sys } = makeSys();
    const { store } = memoryStore();
    const { app } = testServer(sys, store);
    expect((await app.inject({ method: 'GET', url: '/api/nginx/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/nginx/proxies' })).statusCode).toBe(401);
  });

  it('reports running state from pgrep', async () => {
    for (const [pgrepOk, running] of [
      [true, true],
      [false, false],
    ] as const) {
      const { sys } = makeSys({ pgrepOk });
      const { store } = memoryStore();
      const { app } = testServer(sys, store);
      const cookie = await authedCookie(app);
      const res = await app.inject({ method: 'GET', url: '/api/nginx/status', headers: { cookie } });
      expect(res.json()).toEqual({ running });
    }
  });

  it('controls the service with exact commands', async () => {
    const { sys, commands } = makeSys({ conf: NGINX_CONF });
    const { store } = memoryStore();
    const { app } = testServer(sys, store);
    const cookie = await authedCookie(app);
    const act = (action: string) =>
      app.inject({ method: 'POST', url: '/api/nginx/service', headers: { cookie }, payload: { action } });

    expect((await act('start')).json()).toEqual({ ok: true });
    expect((await act('stop')).json()).toEqual({ ok: true });
    expect((await act('reload')).json()).toEqual({ ok: true });
    expect(commands).toEqual([
      'command -v nginx >/dev/null 2>&1',
      'nginx',
      'nginx -s stop',
      'command -v nginx >/dev/null 2>&1',
      'nginx -t',
      'nginx -s reload',
    ]);
    const unknown = await act('bounce');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe('Unknown action');
  });

  it('surfaces bin absence and start failures', async () => {
    const missing = makeSys();
    missing.sys.exec = (cmd) =>
      cmd.startsWith('command -v') ? Promise.reject(new Error('not found')) : Promise.resolve('');
    const { store: storeA } = memoryStore();
    const { app: appA } = testServer(missing.sys, storeA);
    const cookieA = await authedCookie(appA);
    const start = await appA.inject({
      method: 'POST',
      url: '/api/nginx/service',
      headers: { cookie: cookieA },
      payload: { action: 'start' },
    });
    expect(start.statusCode).toBe(400);
    expect(start.json().error).toMatch(/Package "nginx" is not installed/);

    const failing = makeSys({ startOk: false });
    const { store: storeB } = memoryStore();
    const { app: appB } = testServer(failing.sys, storeB);
    const cookieB = await authedCookie(appB);
    const startFail = await appB.inject({
      method: 'POST',
      url: '/api/nginx/service',
      headers: { cookie: cookieB },
      payload: { action: 'start' },
    });
    expect(startFail.statusCode).toBe(400);
    expect(startFail.json().error).toMatch(/Failed to start nginx: bind\(\) failed/);
  });

  it('validates proxy creation', async () => {
    const { sys } = makeSys({ conf: NGINX_CONF });
    const { store } = memoryStore();
    const { app } = testServer(sys, store);
    const cookie = await authedCookie(app);
    const post = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/api/nginx/proxies', headers: { cookie }, payload });

    expect((await post({ listenPort: 8080, targetPort: 3000 })).json().error).toBe('Name is required');
    expect((await post({ name: 'x', listenPort: 80, targetPort: 3000 })).json().error).toBe(
      'Listen port must be 1024-65535 (Termux cannot bind <1024 without root)',
    );
    expect((await post({ name: 'x', listenPort: 8080, targetPort: 0 })).json().error).toBe('Invalid target port');
    expect((await post({ name: 'x', listenPort: 8080, targetPort: 3000, domain: 'bad domain!' })).json().error).toBe(
      'Invalid domain',
    );
  });

  it('creates with conf write, include patch, and single reload', async () => {
    const { sys, files, commands } = makeSys({ conf: NGINX_CONF });
    const { store } = memoryStore();
    const { app, sitesDir } = testServer(sys, store);
    const cookie = await authedCookie(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/nginx/proxies',
      headers: { cookie },
      payload: { name: 'blog', listenPort: 8080, domain: 'example.com', targetPort: 3000 },
    });
    expect(res.statusCode).toBe(200);
    const proxy = res.json().proxy as Proxy;
    expect(proxy.id).toMatch(/^[0-9a-f]{8}$/);
    expect(files.get(`${sitesDir}/panel-${proxy.id}.conf`)).toContain('server_name example.com;');
    const patched = files.get('/etc/nginx/nginx.conf') ?? '';
    expect(patched.match(new RegExp(`include ${escapeRegExp(sitesDir)}/\\*\\.conf;`, 'g'))).toHaveLength(1);
    expect(commands).toContain('nginx -t');
    expect(commands.filter((c) => c === 'nginx -s reload')).toHaveLength(1);

    const list = await app.inject({ method: 'GET', url: '/api/nginx/proxies', headers: { cookie } });
    expect(list.json().proxies).toHaveLength(1);

    const clash = await app.inject({
      method: 'POST',
      url: '/api/nginx/proxies',
      headers: { cookie },
      payload: { name: 'other', listenPort: 8080, targetPort: 4000 },
    });
    expect(clash.statusCode).toBe(400);
    expect(clash.json().error).toBe('Listen port is already used by another proxy');
  });

  it('rolls back the registry when nginx -t fails', async () => {
    const { sys } = makeSys({ conf: NGINX_CONF, testOk: false });
    const handle = memoryStore();
    const { app } = testServer(sys, handle.store);
    const cookie = await authedCookie(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/nginx/proxies',
      headers: { cookie },
      payload: { name: 'bad', listenPort: 8081, targetPort: 3000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/nginx -t failed/);
    expect(handle.all()).toHaveLength(0);
  });

  it('deletes idempotently and cleans confs', async () => {
    const { sys, files } = makeSys({ conf: NGINX_CONF });
    const handle = memoryStore();
    const { app, sitesDir } = testServer(sys, handle.store);
    const cookie = await authedCookie(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/nginx/proxies',
      headers: { cookie },
      payload: { name: 'blog', listenPort: 8082, targetPort: 3000 },
    });
    const id = (created.json().proxy as Proxy).id;
    expect(files.has(`${sitesDir}/panel-${id}.conf`)).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/api/nginx/proxies/${id}`, headers: { cookie } });
    expect(del.json()).toEqual({ ok: true });
    expect(handle.all()).toHaveLength(0);
    expect(files.has(`${sitesDir}/panel-${id}.conf`)).toBe(false);

    const ghost = await app.inject({ method: 'DELETE', url: '/api/nginx/proxies/deadbeef', headers: { cookie } });
    expect(ghost.json()).toEqual({ ok: true });
  });
});
