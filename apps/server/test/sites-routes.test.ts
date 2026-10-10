import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import type { Site, SiteProcess, SiteSpawner, SiteStore } from '../src/sites.js';

const KNOWN_PASSWORD = 'sitespass1';

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

interface SpawnCall {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

class FakeProc implements SiteProcess {
  killed = 0;
  private outputCb: (chunk: string) => void = () => {};
  private exitCb: (code: number | null) => void = () => {};
  private errorCb: (err: Error) => void = () => {};

  kill(): void {
    this.killed++;
  }

  onOutput(cb: (chunk: string) => void): void {
    this.outputCb = cb;
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  emitOutput(chunk: string): void {
    this.outputCb(chunk);
  }

  emitExit(code: number | null): void {
    this.exitCb(code);
  }

  emitError(err: Error): void {
    this.errorCb(err);
  }
}

function makeSpawner(bins: Record<string, boolean> = {}): {
  spawner: SiteSpawner;
  procs: FakeProc[];
  calls: SpawnCall[];
} {
  const procs: FakeProc[] = [];
  const calls: SpawnCall[] = [];
  const spawner: SiteSpawner = {
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      const proc = new FakeProc();
      procs.push(proc);
      return proc;
    },
    hasBin: (bin) => Promise.resolve(bins[bin] ?? true),
  };
  return { spawner, procs, calls };
}

function memoryStore(): SiteStore & { saved: number } {
  let sites: Site[] = [];
  return {
    saved: 0,
    list: () => [...sites],
    save: (next) => {
      sites = [...next];
    },
  };
}

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'sites-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-sites-'));
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

describe('server sites routes', () => {
  it('gates /api/sites with 401', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawner } = makeSpawner();
    const store = memoryStore();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, siteStore: store, siteSpawner: spawner });
    const res = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(res.statusCode).toBe(401);
  });

  it('validates creation with 400s', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawner } = makeSpawner();
    const store = memoryStore();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, siteStore: store, siteSpawner: spawner });
    const cookie = await authedCookie(app);
    const post = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload });

    expect((await post({ type: 'node', path: '', port: 3000 })).json().error).toBe('Name is required');
    expect((await post({ name: 'x', type: 'ruby', path: '', port: 3000 })).json().error).toBe(
      'Type must be nodejs, php, static, or go',
    );
    expect((await post({ name: 'x', type: 'node', path: '', port: 80 })).json().error).toBe('Port must be 1024–65535');
    expect((await post({ name: 'x', type: 'node', path: '', port: 99999 })).json().error).toBe('Port must be 1024–65535');
    expect((await post({ name: 'x', type: 'node', path: 'nope.js', port: 3000 })).json().error).toBe('Path not found');

    mkdirSync(join(root, 'dir'));
    expect((await post({ name: 'x', type: 'node', path: 'dir', port: 3000 })).json().error).toBe(
      'For Node.js, path must be a file (e.g. server.js)',
    );
    writeFileSync(join(root, 'app.php'), '<?php');
    expect((await post({ name: 'x', type: 'php', path: 'app.php', port: 3000 })).json().error).toBe(
      'For PHP, path must be a document root folder',
    );
    expect((await post({ name: 'x', type: 'node', path: '../..', port: 3000 })).statusCode).toBe(400);
  });

  it('creates, lists, and guards port collisions', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawner } = makeSpawner();
    const store = memoryStore();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, siteStore: store, siteSpawner: spawner });
    const cookie = await authedCookie(app);
    writeFileSync(join(root, 'server.js'), 'console.log(1)');
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'web', type: 'node', path: 'server.js', port: 3000 },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().site).toMatchObject({ name: 'web', type: 'node', path: 'server.js', port: 3000 });
    expect(created.json().site.id).toMatch(/^[0-9a-f]{16}$/);

    const list = await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie } });
    expect(list.json().sites).toHaveLength(1);
    expect(list.json().sites[0]).toMatchObject({ name: 'web', running: false });

    const clash = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'other', type: 'node', path: 'server.js', port: 3000 },
    });
    expect(clash.statusCode).toBe(400);
    expect(clash.json().error).toBe('Port is already used by another website');
  });

  it('starts node with PORT env and tracks running', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawner, procs, calls } = makeSpawner();
    const store = memoryStore();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, siteStore: store, siteSpawner: spawner });
    const cookie = await authedCookie(app);
    writeFileSync(join(root, 'server.js'), 'x');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'server.js'), 'x');
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'web', type: 'node', path: join('sub', 'server.js'), port: 3001 },
    });
    const id = created.json().site.id as string;
    const started = await app.inject({ method: 'POST', url: `/api/sites/${id}/start`, headers: { cookie } });
    expect(started.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: 'node', args: [join(root, 'sub', 'server.js')], cwd: join(root, 'sub') });
    expect(calls[0]?.env['PORT']).toBe('3001');

    const list = await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie } });
    expect(list.json().sites[0].running).toBe(true);

    const again = await app.inject({ method: 'POST', url: `/api/sites/${id}/start`, headers: { cookie } });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('Already running');
    expect(procs).toHaveLength(1);
  });

  it('streams logs, trims the ring, and retains dead logs', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawner, procs } = makeSpawner();
    const store = memoryStore();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, siteStore: store, siteSpawner: spawner });
    const cookie = await authedCookie(app);
    writeFileSync(join(root, 'server.js'), 'x');
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'web', type: 'node', path: 'server.js', port: 3002 },
    });
    const id = created.json().site.id as string;
    await app.inject({ method: 'POST', url: `/api/sites/${id}/start`, headers: { cookie } });
    procs[0]?.emitOutput('line1\n');
    const live = await app.inject({ method: 'GET', url: `/api/sites/${id}/logs`, headers: { cookie } });
    expect(live.json()).toMatchObject({ running: true });
    expect(live.json().logs as string).toContain('--- start (node) port 3002 ---');
    expect(live.json().logs as string).toContain('line1');

    for (let i = 0; i < 310; i++) procs[0]?.emitOutput('x\n');
    procs[0]?.emitExit(0);
    const dead = await app.inject({ method: 'GET', url: `/api/sites/${id}/logs`, headers: { cookie } });
    expect(dead.json().running).toBe(false);
    const lines = (dead.json().logs as string).split('\n').filter((l) => l === 'x');
    expect(lines).toHaveLength(299); // 300-ring minus the exit banner pushed last
    expect(dead.json().logs as string).not.toContain('--- start');
    expect(dead.json().logs as string).toContain('--- stopped (exit 0) ---');

    const list = await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie } });
    expect(list.json().sites[0].running).toBe(false);
  });

  it('records spawn failures without hanging', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawner, procs } = makeSpawner();
    const store = memoryStore();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, siteStore: store, siteSpawner: spawner });
    const cookie = await authedCookie(app);
    writeFileSync(join(root, 'server.js'), 'x');
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'web', type: 'node', path: 'server.js', port: 3003 },
    });
    const id = created.json().site.id as string;
    await app.inject({ method: 'POST', url: `/api/sites/${id}/start`, headers: { cookie } });
    procs[0]?.emitError(new Error('spawn ENOENT'));
    const logs = await app.inject({ method: 'GET', url: `/api/sites/${id}/logs`, headers: { cookie } });
    expect(logs.json().running).toBe(false);
    expect(logs.json().logs as string).toContain('--- failed to start: spawn ENOENT ---');
  });

  it('stops, restarts, and deletes with kills', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawner, procs, calls } = makeSpawner();
    const store = memoryStore();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, siteStore: store, siteSpawner: spawner });
    const cookie = await authedCookie(app);
    writeFileSync(join(root, 'server.js'), 'x');
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      headers: { cookie },
      payload: { name: 'web', type: 'node', path: 'server.js', port: 3004 },
    });
    const id = created.json().site.id as string;

    const idleStop = await app.inject({ method: 'POST', url: `/api/sites/${id}/stop`, headers: { cookie } });
    expect(idleStop.statusCode).toBe(400);

    await app.inject({ method: 'POST', url: `/api/sites/${id}/start`, headers: { cookie } });
    const stopped = await app.inject({ method: 'POST', url: `/api/sites/${id}/stop`, headers: { cookie } });
    expect(stopped.json()).toEqual({ ok: true });
    expect(procs[0]?.killed).toBe(1);
    const afterStop = await app.inject({ method: 'GET', url: `/api/sites/${id}/logs`, headers: { cookie } });
    expect(afterStop.json()).toEqual({ logs: '', running: false });

    await app.inject({ method: 'POST', url: `/api/sites/${id}/start`, headers: { cookie } });
    const restarted = await app.inject({ method: 'POST', url: `/api/sites/${id}/restart`, headers: { cookie } });
    expect(restarted.json()).toEqual({ ok: true });
    expect(procs[1]?.killed).toBe(1);
    expect(calls).toHaveLength(3);

    const deleted = await app.inject({ method: 'POST', url: `/api/sites/${id}/delete`, headers: { cookie } });
    expect(deleted.json()).toEqual({ ok: true });
    expect(procs[2]?.killed).toBe(1);
    expect(store.list()).toHaveLength(0);
    const gone = await app.inject({ method: 'GET', url: `/api/sites/${id}/logs`, headers: { cookie } });
    expect(gone.statusCode).toBe(404);
  });

  it('spawns php static go with exact shapes and bin gates', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawner, calls } = makeSpawner({ python3: false, go: false });
    const store = memoryStore();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, siteStore: store, siteSpawner: spawner });
    const cookie = await authedCookie(app);
    mkdirSync(join(root, 'phpapp'));
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'goapp'));
    const mk = (name: string, type: string, path: string, port: number) =>
      app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name, type, path, port } });
    const phpId = ((await mk('p', 'php', 'phpapp', 4001)).json().site as Site).id;
    const staticId = ((await mk('s', 'static', 'dist', 4002)).json().site as Site).id;
    const goId = ((await mk('g', 'go', 'goapp', 4003)).json().site as Site).id;

    const phpStart = await app.inject({ method: 'POST', url: `/api/sites/${phpId}/start`, headers: { cookie } });
    expect(phpStart.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({
      cmd: 'php',
      args: ['-S', '127.0.0.1:4001', '-t', join(root, 'phpapp')],
      cwd: join(root, 'phpapp'),
    });

    const staticStart = await app.inject({ method: 'POST', url: `/api/sites/${staticId}/start`, headers: { cookie } });
    expect(staticStart.statusCode).toBe(400);
    expect(staticStart.json().error).toMatch(/Install python/);
    const goStart = await app.inject({ method: 'POST', url: `/api/sites/${goId}/start`, headers: { cookie } });
    expect(goStart.statusCode).toBe(400);
    expect(goStart.json().error).toMatch(/Install Go/);
  });

  it('answers 404 for unknown ids', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawner } = makeSpawner();
    const store = memoryStore();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, siteStore: store, siteSpawner: spawner });
    const cookie = await authedCookie(app);
    const missing = '0123456789abcdef';
    for (const [method, url] of [
      ['POST', `/api/sites/${missing}/start`],
      ['POST', `/api/sites/${missing}/stop`],
      ['POST', `/api/sites/${missing}/restart`],
      ['POST', `/api/sites/${missing}/delete`],
      ['GET', `/api/sites/${missing}/logs`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie }, payload: {} });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Website not found' });
    }
  });
});
