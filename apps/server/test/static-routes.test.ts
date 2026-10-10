import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { resolveDistDir } from '../src/static.js';

const KNOWN_PASSWORD = 'staticpass1';

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

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'static-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-static-'));
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

function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olp-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="app"></div>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
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

describe('resolveDistDir', () => {
  it('honors the override and rejects missing builds', () => {
    const dir = fakeDist();
    process.env['OLP_WEB_DIR'] = dir;
    try {
      expect(resolveDistDir()).toBe(dir);
    } finally {
      delete process.env['OLP_WEB_DIR'];
    }
    expect(resolveDistDir('file:///definitely/not/here.js')).toBeUndefined();
  });

  it('resolves the sibling apps/web/dist from server module depth', () => {
    const root = mkdtempSync(join(tmpdir(), 'olp-layout-'));
    const serverDir = join(root, 'apps', 'server', 'dist');
    const webDist = join(root, 'apps', 'web', 'dist');
    mkdirSync(serverDir, { recursive: true });
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, 'index.html'), 'x');
    expect(resolveDistDir(`file://${join(serverDir, 'index.js')}`)).toBe(webDist);
  });
});

describe('server static routes', () => {
  it('redirects / by session', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, webDir: null });
    const anon = await app.inject({ method: 'GET', url: '/' });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers['location']).toBe('/login');
    const cookie = await authedCookie(app);
    const authed = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(authed.headers['location']).toBe('/dashboard');
  });

  it('serves assets, falls back slugs, and keeps API 404s JSON', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const dist = fakeDist();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, webDir: dist });
    const cookie = await authedCookie(app);

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js', headers: { cookie } });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('javascript');

    const slug = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
    expect(slug.statusCode).toBe(200);
    expect(slug.body).toContain('<div id="app"></div>');

    const api404 = await app.inject({ method: 'GET', url: '/api/db/nope/config', headers: { cookie } });
    expect(api404.statusCode).toBe(404);
    expect(api404.json()).toEqual({ error: 'Not found' });
  });

  it('runs API-only without a dist dir', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, webDir: null });
    const cookie = await authedCookie(app);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
    expect(missing.statusCode).toBe(404);
  });
});
