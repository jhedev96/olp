import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

const KNOWN_PASSWORD = 'statspass1';

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
    cpus: () => [{}, {}],
    loadavg: () => [0.5, 0.25, 0.1],
    totalmem: () => 1000,
    freemem: () => 400,
    hostname: () => 'stats-box',
    uptime: () => 90.9,
    exec: (cmd) => {
      if (cmd.startsWith('df')) {
        return Promise.resolve('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 2000 500 1500 25% /\n');
      }
      return Promise.reject(new Error('unexpected exec'));
    },
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshDirs(): { dataDir: string; legacyDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-stats-'));
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

describe('server stats route', () => {
  it('gates /api/stats with 401', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps() });
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(401);
  });

  it('serves the sysinfo payload with zero os imports in routes', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps(), root: '/' });
    const cookie = await authedCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/stats', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      hostname: 'stats-box',
      uptime: 90,
      time: 1728470400000,
      cpu: { load1: 0.5, load5: 0.25, load15: 0.1, cores: 2 },
      mem: { total: 1000, free: 400, used: 600, percent: 60 },
      disk: { total: 2000 * 1024, used: 500 * 1024, free: 1500 * 1024, percent: 25 },
      battery: { error: 'unavailable' },
    });
  });
});
