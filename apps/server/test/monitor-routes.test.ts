import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

const KNOWN_PASSWORD = 'monitorpass1';

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

const STAT = [
  'cpu  100 0 50 850 0 0 0 0 0 0',
  'cpu0  60 0 30 510 0 0 0 0 0 0',
  'btime 1728000000',
].join('\n');

function fakeDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0.42, 0.38, 0.29],
    totalmem: () => 8000,
    freemem: () => 2000,
    hostname: () => 'mon-box',
    uptime: () => 120.5,
    arch: () => 'x64',
    exec: (cmd) => {
      if (cmd.startsWith('df')) {
        return Promise.resolve('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 2000 500 1500 25% /\n');
      }
      if (cmd === 'pm2 jlist') return Promise.resolve('[{"name":"api","pid":7,"pm2_env":{"status":"online"},"monit":{"cpu":0.5,"memory":1000}}]');
      return Promise.reject(new Error('unexpected exec'));
    },
    readDir: (p) => {
      if (p === '/proc') return ['42'];
      if (p === '/sys/block') return [];
      throw new Error(`unexpected dir: ${p}`);
    },
    readFile: (p) => {
      if (p === '/proc/stat') return STAT;
      if (p === '/proc/cpuinfo') return 'model name\t: Route CPU\n';
      if (p === '/proc/42/stat') return '42 (worker) R 0 0 0 0 0 0 0 0 0 0 30 10 0 0 0 0 0 0 2000 0 0 0 0';
      if (p === '/proc/42/status') return 'Name:\tworker\nVmRSS:\t  2048 kB\n';
      if (p === '/proc/42/cmdline') return 'node\0worker.js\0';
      return null;
    },
    now: () => 1728470400000,
  };
}

function freshDirs(): { dataDir: string; legacyDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-monitor-'));
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

describe('server monitor routes', () => {
  it('gates both routes with 401', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps() });
    expect((await app.inject({ method: 'GET', url: '/api/monitor/summary' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/monitor/processes' })).statusCode).toBe(401);
  });

  it('serves the summary shape with first-poll nulls', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps(), root: '/' });
    const cookie = await authedCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/monitor/summary', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      hostname: 'mon-box',
      uptime: 120,
      time: 1728470400000,
      arch: 'x64',
      kernel: null,
      cpu: {
        load1: 0.42,
        load5: 0.38,
        load15: 0.29,
        cores: 1,
        perCore: [{ index: 0, percent: null, freqMhz: null }],
        model: 'Route CPU',
        tempC: null,
      },
      mem: {
        total: 8000,
        free: 2000,
        used: 6000,
        percent: 75,
        swapTotal: null,
        swapFree: null,
        buffers: null,
        cached: null,
      },
      disk: {
        total: 2000 * 1024,
        used: 500 * 1024,
        free: 1500 * 1024,
        percent: 25,
        io: null,
      },
      net: { interfaces: [], listeningPorts: [] },
      battery: { error: 'unavailable' },
    });
  });

  it('serves processes with limit clamp and pm2 rows', async () => {
    const { dataDir, legacyDir } = freshDirs();
    seedKnown(dataDir);
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps(), root: '/' });
    const cookie = await authedCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/monitor/processes', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      processes: [
        {
          pid: 42,
          command: 'node worker.js',
          cpuPercent: null,
          memBytes: 2048 * 1024,
          uptimeSec: 1728470400 - 1728000000 - 20,
        },
      ],
      pm2: [{ name: 'api', pid: 7, status: 'online', cpuPercent: 0.5, memBytes: 1000 }],
      truncated: false,
    });
    const clamped = await app.inject({
      method: 'GET',
      url: '/api/monitor/processes?limit=9999',
      headers: { cookie },
    });
    expect(clamped.json().processes).toHaveLength(1);
    const one = await app.inject({ method: 'GET', url: '/api/monitor/processes?limit=bogus', headers: { cookie } });
    expect(one.json().processes).toHaveLength(1);
  });
});
