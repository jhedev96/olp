import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { mountCandidates, probeMounts } from '../src/mounts.js';

const KNOWN_PASSWORD = 'mountspass1';

const debianEnv: Environment = {
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

const termuxEnv: Environment = { ...debianEnv, id: 'termux', prettyName: 'Termux', prefix: '/data/data/com.termux/files/usr' };

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'mounts-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-mounts-'));
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

describe('mount candidates', () => {
  it('always lists root first with per-env extras', () => {
    expect(mountCandidates(debianEnv, '/r', '/home/u')).toEqual(['/r', '/home/u']);
    expect(mountCandidates(debianEnv, '/r', '/r')).toEqual(['/r']);
    expect(mountCandidates(termuxEnv, '/r', '/data/data/com.termux/files/home')).toEqual([
      '/r',
      '/data/data/com.termux/files/home/storage',
      '/storage/emulated/0',
    ]);
  });
});

describe('server mounts routes', () => {
  it('gates with 401 and probes honestly', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { app } = buildServer({ dataDir, legacyDir, env: debianEnv, sysDeps: quietDeps(), root });
    expect((await app.inject({ method: 'GET', url: '/api/mounts' })).statusCode).toBe(401);
    const cookie = await authedCookie(app);
    const res = await app.inject({ method: 'GET', url: '/api/mounts', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const mounts = (res.json() as { mounts: Array<{ path: string; present: boolean; dir: boolean }> }).mounts;
    expect(mounts[0]).toEqual({ path: root, present: true, dir: true });
    expect(mounts.every((m) => typeof m.path === 'string' && typeof m.present === 'boolean' && typeof m.dir === 'boolean')).toBe(true);
  });

  it('marks absent paths without creating them', async () => {
    const probed = await probeMounts([tmpdir(), join(tmpdir(), 'olp-no-such-dir-xyz')]);
    expect(probed[0]).toMatchObject({ present: true, dir: true });
    expect(probed[1]).toEqual({ path: join(tmpdir(), 'olp-no-such-dir-xyz'), present: false, dir: false });
  });
});
