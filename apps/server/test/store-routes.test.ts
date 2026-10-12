import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvId, Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { parseMirrorHost } from '../src/store.js';

const KNOWN_PASSWORD = 'storepass1';

function makeEnv(id: EnvId): Environment {
  return {
    id,
    prettyName: id,
    pkgman: 'none',
    service: 'none',
    isWsl: false,
    prefix: '',
    shell: 'sh',
    pathExtra: [],
  };
}

interface Spawned {
  cmd: string;
  cwd: string;
  emit(chunk: string): void;
  done(code: number): void;
  fail(err: Error): void;
}

function makeSpawn(): {
  spawn: (cmd: string, cwd: string, onData: (c: string) => void, onDone: (code: number | null, err: Error | null) => void) => { kill(): void };
  runs: Spawned[];
} {
  const runs: Spawned[] = [];
  const spawn = (
    cmd: string,
    cwd: string,
    onData: (chunk: string) => void,
    onDone: (code: number | null, err: Error | null) => void,
  ): { kill(): void } => {
    const run: Spawned = {
      cmd,
      cwd,
      emit: (chunk) => onData(chunk),
      done: (code) => onDone(code, null),
      fail: (err) => onDone(null, err),
    };
    runs.push(run);
    return { kill: () => {} };
  };
  return { spawn, runs };
}

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'store-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-store-'));
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

describe('server store routes', () => {
  it('gates with 401', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { app } = buildServer({ dataDir, legacyDir, env: makeEnv('termux'), sysDeps: quietDeps(), root });
    expect((await app.inject({ method: 'GET', url: '/api/install' })).statusCode).toBe(401);
  });

  it('lists forced, installed, and installing flags', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawn } = makeSpawn();
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: makeEnv('termux'),
      sysDeps: quietDeps(),
      root,
      storeCheck: (cmd) => Promise.resolve(cmd.includes('nginx')),
      storeSpawn: spawn,
    });
    const cookie = await authedCookie(app);
    const byId = async () => {
      const res = await app.inject({ method: 'GET', url: '/api/install', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      return new Map((res.json().items as Array<{ id: string; installed: boolean; installing: boolean }>).map((i) => [i.id, i]));
    };
    expect((await byId()).get('nodejs')).toMatchObject({ installed: true, installing: false });
    expect((await byId()).get('nginx')).toMatchObject({ installed: true, installing: false });
    expect((await byId()).get('php')).toMatchObject({ installed: false, installing: false });

    await app.inject({ method: 'POST', url: '/api/install/php/start', headers: { cookie } });
    expect((await byId()).get('php')).toMatchObject({ installed: false, installing: true });
  });

  it('rejects unknown, busy, and unavailable starts', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawn } = makeSpawn();
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: makeEnv('windows'),
      sysDeps: quietDeps(),
      root,
      storeCheck: () => Promise.resolve(false),
      storeSpawn: spawn,
    });
    const cookie = await authedCookie(app);
    const unknown = await app.inject({ method: 'POST', url: '/api/install/nope/start', headers: { cookie } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: 'Unknown package' });

    expect((await app.inject({ method: 'POST', url: '/api/install/pm2/start', headers: { cookie } })).statusCode).toBe(200);
    const busy = await app.inject({ method: 'POST', url: '/api/install/pm2/start', headers: { cookie } });
    expect(busy.statusCode).toBe(400);
    expect(busy.json()).toEqual({ error: 'Installation already running' });

    const unavailable = await app.inject({ method: 'POST', url: '/api/install/nginx/start', headers: { cookie } });
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json().error).toBe('Install command unavailable for windows (nginx)');
  });

  it('streams logs, banners, exit codes, and notifications', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawn, runs } = makeSpawn();
    const noted: string[] = [];
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: makeEnv('termux'),
      sysDeps: quietDeps(),
      root,
      storeCheck: () => Promise.resolve(false),
      storeSpawn: spawn,
      storeNotify: (text) => {
        noted.push(text);
      },
    });
    const cookie = await authedCookie(app);
    expect((await app.inject({ method: 'POST', url: '/api/install/redis/start', headers: { cookie } })).statusCode).toBe(200);
    expect(runs[0]?.cmd).toBe('pkg install -y redis');
    expect(runs[0]?.cwd).not.toBe('');
    runs[0]?.emit('Reading package lists...\n');
    runs[0]?.done(0);

    const log = await app.inject({ method: 'GET', url: '/api/install/redis/log', headers: { cookie } });
    expect(log.json()).toMatchObject({ running: false, exitCode: 0 });
    expect(log.json().logs as string).toContain('$ pkg install -y redis');
    expect(log.json().logs as string).toContain('Reading package lists...');
    expect(log.json().logs as string).toContain('--- finished (exit 0) ---');
    expect(noted).toEqual(['✅ Install Redis finished (exit 0)']);

    expect((await app.inject({ method: 'POST', url: '/api/install/php/start', headers: { cookie } })).statusCode).toBe(200);
    runs[1]?.done(1);
    const log2 = await app.inject({ method: 'GET', url: '/api/install/php/log', headers: { cookie } });
    expect(log2.json()).toMatchObject({ running: false, exitCode: 1 });
    expect(noted[1]).toBe('❌ Install PHP finished (exit 1)');

    expect((await app.inject({ method: 'POST', url: '/api/install/git/start', headers: { cookie } })).statusCode).toBe(200);
    runs[2]?.fail(new Error('spawn bash ENOENT'));
    const log3 = await app.inject({ method: 'GET', url: '/api/install/git/log', headers: { cookie } });
    expect(log3.json()).toMatchObject({ running: false, exitCode: -1 });
    expect(log3.json().logs as string).toContain('--- failed: spawn bash ENOENT ---');
    expect(noted).toHaveLength(2);
  });

  it('trims the ring and answers empty logs', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawn, runs } = makeSpawn();
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: makeEnv('termux'),
      sysDeps: quietDeps(),
      root,
      storeCheck: () => Promise.resolve(false),
      storeSpawn: spawn,
    });
    const cookie = await authedCookie(app);
    const empty = await app.inject({ method: 'GET', url: '/api/install/zip/log', headers: { cookie } });
    expect(empty.json()).toEqual({ logs: '', running: false, exitCode: null });

    await app.inject({ method: 'POST', url: '/api/install/zip/start', headers: { cookie } });
    for (let i = 0; i < 510; i++) runs[0]?.emit(`line${i}\n`);
    runs[0]?.done(0);
    const log = await app.inject({ method: 'GET', url: '/api/install/zip/log', headers: { cookie } });
    const text = log.json().logs as string;
    expect(text).not.toContain('$ pkg install -y zip');
    expect(text).toContain('line509');
    expect(text.split('\n').length).toBeLessThanOrEqual(502);
  });

  it('lists conf paths alongside flags', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawn } = makeSpawn();
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: makeEnv('termux'),
      sysDeps: quietDeps(),
      root,
      storeCheck: () => Promise.resolve(false),
      storeSpawn: spawn,
    });
    const cookie = await authedCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/install', headers: { cookie } });
    const byId = new Map(
      (res.json().items as Array<{ id: string; conf: string | null }>).map((i) => [i.id, i.conf]),
    );
    expect(byId.get('nginx')).toBe('$PREFIX/etc/nginx/nginx.conf');
    expect(byId.get('git')).toBe('~/.gitconfig');
    expect(byId.get('redis')).toBeNull();
  });

  it('serves versions with installed-gating and honest nulls', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawn } = makeSpawn();
    const execCalls: string[] = [];
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: makeEnv('termux'),
      sysDeps: quietDeps(),
      root,
      storeCheck: (cmd) => Promise.resolve(cmd.includes('nginx')),
      storeExec: (cmd) => {
        execCalls.push(cmd);
        if (cmd.startsWith('nginx')) return Promise.resolve('nginx version: openresty/1.21.4.1\nbuilt by gcc\n');
        return Promise.reject(new Error('no node here'));
      },
      storeSpawn: spawn,
    });
    const cookie = await authedCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/install/versions', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const versions = res.json().versions as Record<string, string | null>;
    expect(versions['nginx']).toBe('nginx version: openresty/1.21.4.1');
    expect(versions['php']).toBeNull(); // uninstalled: no version spawn at all
    expect(versions['nodejs']).toBeNull(); // forced-installed but the probe failed
    expect(execCalls.some((c) => c.includes('php'))).toBe(false);
    expect(execCalls.some((c) => c.startsWith('nginx'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/install/versions' })).statusCode).toBe(401);
  });

  it('runs update and upgrade with busy and unavailable guards', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawn, runs } = makeSpawn();
    const noted: string[] = [];
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: makeEnv('termux'),
      sysDeps: quietDeps(),
      root,
      storeCheck: () => Promise.resolve(false),
      storeSpawn: spawn,
      storeNotify: (text) => {
        noted.push(text);
      },
    });
    const cookie = await authedCookie(app);
    expect((await app.inject({ method: 'GET', url: '/api/install/upgrade/log', headers: { cookie } })).json()).toEqual({
      logs: '',
      running: false,
      exitCode: null,
    });
    expect((await app.inject({ method: 'POST', url: '/api/install/update/start', headers: { cookie } })).json()).toEqual({
      ok: true,
    });
    expect(runs[0]?.cmd).toBe('pkg update');
    const busy = await app.inject({ method: 'POST', url: '/api/install/update/start', headers: { cookie } });
    expect(busy.statusCode).toBe(400);
    expect(busy.json()).toEqual({ error: 'Repo update already running' });
    runs[0]?.done(0);
    expect((await app.inject({ method: 'GET', url: '/api/install/update/log', headers: { cookie } })).json()).toMatchObject({
      running: false,
      exitCode: 0,
    });
    expect(noted).toEqual(['✅ Repo update finished (exit 0)']);

    expect((await app.inject({ method: 'POST', url: '/api/install/upgrade/start', headers: { cookie } })).statusCode).toBe(200);
    expect(runs[1]?.cmd).toBe('pkg upgrade -y');
    runs[1]?.done(1);
    expect(noted[1]).toBe('❌ Batch upgrade finished (exit 1)');
    expect((await app.inject({ method: 'POST', url: '/api/install/update/start' })).statusCode).toBe(401);
  });

  it('answers unavailable manager ops and keeps static routes off the parametric id', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { spawn } = makeSpawn();
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: makeEnv('windows'),
      sysDeps: quietDeps(),
      root,
      storeCheck: () => Promise.resolve(false),
      storeSpawn: spawn,
    });
    const cookie = await authedCookie(app);
    // Static routes win: these are manager ops, never 'Unknown package'.
    expect((await app.inject({ method: 'POST', url: '/api/install/update/start', headers: { cookie } })).json().error).toBe(
      'Repo update unavailable for windows',
    );
    expect((await app.inject({ method: 'POST', url: '/api/install/upgrade/start', headers: { cookie } })).json().error).toBe(
      'Batch upgrade unavailable for windows',
    );
    expect((await app.inject({ method: 'GET', url: '/api/install/versions', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/install/mirror', headers: { cookie } })).json()).toEqual({
      manager: null,
      mirror: null,
      latencyMs: null,
    });
  });

  it('parses mirror hosts and times termux latency honestly', () => {
    expect(parseMirrorHost('deb https://packages.termux.dev/apt/termux-main/ stable main\n')).toBe('packages.termux.dev');
    expect(parseMirrorHost('# comment\ndeb not-a-url stable main\n')).toBeNull();
    expect(parseMirrorHost('just some text\n')).toBeNull();
    expect(parseMirrorHost('deb https://exa mple.com/ stable main\n')).toBeNull();
  });

  it('serves termux mirror with dns success, failure, and non-termux nulls', async () => {
    const sources = 'deb https://packages.termux.dev/apt/termux-main/ stable main\n';
    const buildMirror = (dns: (host: string) => Promise<unknown>, env: EnvId, manager: 'pkg' | 'apt' = 'pkg') => {
      const { dataDir, legacyDir, root } = freshWorkspace();
      const { spawn } = makeSpawn();
      return buildServer({
        dataDir,
        legacyDir,
        env: { ...makeEnv(env), pkgman: manager === 'pkg' ? 'pkg' : 'apt' },
        sysDeps: quietDeps(),
        root,
        storeCheck: () => Promise.resolve(false),
        storeSpawn: spawn,
        storeManager: manager,
        storePrefix: '/p',
        storeReadSource: (path) => (path === '/p/etc/apt/sources.list' ? sources : null),
        storeDns: dns,
      });
    };
    const { app } = buildMirror(() => Promise.resolve({ address: '1.2.3.4' }), 'termux');
    const cookie = await authedCookie(app);
    const ok = await app.inject({ method: 'GET', url: '/api/install/mirror', headers: { cookie } });
    expect(ok.json().manager).toBe('pkg');
    expect(ok.json().mirror).toBe('packages.termux.dev');
    expect(typeof ok.json().latencyMs).toBe('number');

    const { app: app2 } = buildMirror(() => Promise.reject(new Error('EAI_AGAIN')), 'termux');
    const cookie2 = await authedCookie(app2);
    expect((await app2.inject({ method: 'GET', url: '/api/install/mirror', headers: { cookie: cookie2 } })).json()).toMatchObject({
      manager: 'pkg',
      mirror: 'packages.termux.dev',
      latencyMs: null,
    });

    const { app: app3 } = buildMirror(() => Promise.resolve({}), 'debian', 'apt');
    const cookie3 = await authedCookie(app3);
    expect((await app3.inject({ method: 'GET', url: '/api/install/mirror', headers: { cookie: cookie3 } })).json()).toEqual({
      manager: 'apt',
      mirror: null,
      latencyMs: null,
    });
    expect((await app3.inject({ method: 'GET', url: '/api/install/mirror' })).statusCode).toBe(401);
  });
});
