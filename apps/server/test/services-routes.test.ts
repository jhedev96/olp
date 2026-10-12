import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { ServiceController } from '@olp/services';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';

const KNOWN_PASSWORD = 'servicespass1';

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

function fakeDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0.1, 0.1, 0.1],
    totalmem: () => 1000,
    freemem: () => 400,
    hostname: () => 'svc-box',
    uptime: () => 10,
    arch: () => 'x64',
    exec: () => Promise.reject(new Error('unexpected exec')),
    readDir: (p) => {
      if (p === '/proc') return ['11', '22'];
      throw new Error(`unexpected dir: ${p}`);
    },
    readFile: (p) => {
      if (p === '/proc/11/comm') return 'mysqld\n';
      if (p === '/proc/22/comm') return 'crond\n';
      return null;
    },
    now: () => 1728470400000,
  };
}

function fakeController(start: (service: string) => Promise<void> = () => Promise.resolve()): {
  controllerOf: (manager: string, exec: SysDeps['exec']) => ServiceController;
  started: string[];
} {
  const started: string[] = [];
  return {
    started,
    controllerOf: () => ({
      isActive: () => Promise.resolve(false),
      start: (service: string) => {
        started.push(service);
        return start(service);
      },
      stop: () => Promise.resolve(),
    }),
  };
}

function freshDirs(): { dataDir: string; legacyDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-services-'));
  return { dataDir: join(base, 'data'), legacyDir: join(base, 'legacy') };
}

function seedKnown(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      username: 'tester',
      salt: '0'.repeat(32),
      hash: hashPassword(KNOWN_PASSWORD, '0'.repeat(32)),
    }),
  );
}

async function authedCookie(app: FastifyInstance): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'tester', password: KNOWN_PASSWORD },
  });
  const raw = login.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : (raw as string);
  return (first ?? '').split(';')[0] ?? '';
}

describe('server services routes', () => {
  it('gates both routes with 401', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { controllerOf } = fakeController();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps(), servicesControllerOf: controllerOf });
    expect((await app.inject({ method: 'GET', url: '/api/services' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/services/mariadb/start' })).statusCode).toBe(401);
  });

  it('reports presence with static labels and ports', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { controllerOf } = fakeController();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps(), servicesControllerOf: controllerOf, root: '/' });
    const cookie = await authedCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/services', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      services: [
        { id: 'mariadb', name: 'MariaDB', port: 3306, active: true },
        { id: 'postgres', name: 'PostgreSQL', port: 5432, active: false },
        { id: 'redis', name: 'Redis', port: 6379, active: false },
        { id: 'cronie', name: 'Cronie', port: null, active: true },
      ],
    });
  });

  it('starts known units and surfaces controller errors capped', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { controllerOf, started } = fakeController(() => Promise.reject(new Error(`Failed to start x: ${'y'.repeat(500)}`)));
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps(), servicesControllerOf: controllerOf, root: '/' });
    const cookie = await authedCookie(app);
    const fail = await app.inject({ method: 'POST', url: '/api/services/postgres/start', headers: { cookie } });
    expect(fail.statusCode).toBe(500);
    expect(fail.json().error.length).toBeLessThanOrEqual(300);
    expect(started).toEqual(['postgresql']);
    const unknown = await app.inject({ method: 'POST', url: '/api/services/ntsysv/start', headers: { cookie } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'Unknown service' });
  });

  it('answers 500 without a supported init system', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: { ...fakeEnv, service: 'none' },
      sysDeps: fakeDeps(),
      servicesControllerOf: () => { throw new Error('No supported init system detected'); },
      root: '/',
    });
    const cookie = await authedCookie(app);
    const res = await app.inject({ method: 'POST', url: '/api/services/mariadb/start', headers: { cookie } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'No supported init system detected' });
  });

  it('starts through the default controller wiring', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const spy = vi.fn((_manager: string, _exec: SysDeps['exec']) => fakeController().controllerOf(_manager, _exec));
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps(), servicesControllerOf: spy, root: '/' });
    const cookie = await authedCookie(app);
    const res = await app.inject({ method: 'POST', url: '/api/services/redis/start', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith('systemd', expect.any(Function));
  });
});
