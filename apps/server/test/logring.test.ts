import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { createLogRing } from '../src/logring.js';
import type { LogRing } from '../src/logring.js';

const KNOWN_PASSWORD = 'logspass123';

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
    hostname: () => 'logs-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-logs-'));
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

describe('log ring', () => {
  it('evicts oldest past the cap, newest last', () => {
    const ring = createLogRing(3);
    ring.append('info', 'a', 1);
    ring.append('info', 'b', 2);
    ring.append('warn', 'c', 3);
    ring.append('error', 'd', 4);
    expect(ring.list()).toEqual([
      { t: 2, level: 'info', msg: 'b' },
      { t: 3, level: 'warn', msg: 'c' },
      { t: 4, level: 'error', msg: 'd' },
    ]);
  });

  it('clamps tails and falls back on garbage', () => {
    const ring = createLogRing();
    ring.append('info', 'x', 1);
    expect(ring.list(0)).toHaveLength(1);
    expect(ring.list(500)).toHaveLength(1);
    expect(ring.list(Number.NaN)).toHaveLength(1);
  });
});

describe('server logs routes', () => {
  function rig(): { app: FastifyInstance; ring: LogRing } {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const ring = createLogRing();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, logs: ring });
    return { app, ring };
  }

  async function login(app: FastifyInstance, password: string = KNOWN_PASSWORD): Promise<{ status: number; cookie: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'tester', password } });
    const raw = res.headers['set-cookie'];
    const first = Array.isArray(raw) ? raw[0] : (raw as string);
    return { status: res.statusCode, cookie: (first ?? '').split(';')[0] ?? '' };
  }

  it('gates with 401 and serves the boot line', async () => {
    const { app, ring } = rig();
    expect((await app.inject({ method: 'GET', url: '/api/logs' })).statusCode).toBe(401);
    const { cookie } = await login(app);
    const res = await app.inject({ method: 'GET', url: '/api/logs?tail=10', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const logs = (res.json() as { logs: Array<{ t: number; level: string; msg: string }> }).logs;
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.msg).toContain('OLP boot');
    expect(ring.list()).toHaveLength(logs.length);
  });

  it('feeds login outcomes without secrets', async () => {
    const { app, ring } = rig();
    expect((await login(app, 'nope')).status).toBe(401);
    const { cookie } = await login(app);
    expect((await app.inject({ method: 'GET', url: '/api/logs?tail=200', headers: { cookie } })).statusCode).toBe(200);
    const msgs = ring.list(200).map((l) => `${l.level}:${l.msg}`);
    expect(msgs.some((m) => m.includes('Login failed (tester)'))).toBe(true);
    expect(msgs.some((m) => m.includes('Login ok (tester)'))).toBe(true);
    expect(msgs.some((m) => m.includes('nope') || m.includes(KNOWN_PASSWORD))).toBe(false);
  });

  it('feeds chmod denials', async () => {
    const { app, ring } = rig();
    const { cookie } = await login(app);
    const res = await app.inject({ method: 'POST', url: '/api/chmod', headers: { cookie }, payload: { path: '', name: 'x', mode: 'abc' } });
    expect(res.statusCode).toBe(400);
    expect(ring.list(200).some((l) => l.level === 'warn' && l.msg.includes('Chmod denied'))).toBe(true);
  });
});
