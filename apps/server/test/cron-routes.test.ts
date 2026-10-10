import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { cronJobLine, parseCronLine, toggleCronLine } from '../src/cron.js';
import type { CronBackend } from '../src/cron.js';

const KNOWN_PASSWORD = 'cronpass12';

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

function memoryBackend(seed: string[] = [], bins: Record<string, boolean> = {}): CronBackend & {
  lines: string[];
  execs: Array<{ cmd: string }>;
  spawns: Array<{ cmd: string; args: string[] }>;
} {
  const lines = [...seed];
  const execs: Array<{ cmd: string }> = [];
  const spawns: Array<{ cmd: string; args: string[] }> = [];
  return {
    lines,
    execs,
    spawns,
    readLines: () => Promise.resolve([...lines]),
    writeLines: (next) => {
      lines.length = 0;
      lines.push(...next);
      return Promise.resolve();
    },
    exec: (cmd) => {
      execs.push({ cmd });
      if (cmd.startsWith('pgrep')) {
        return (bins['crond'] ?? true) ? Promise.resolve('') : Promise.reject(new Error('no match'));
      }
      return Promise.resolve('');
    },
    spawnDetached: (cmd, args) => {
      spawns.push({ cmd, args });
    },
    hasBin: (bin) => Promise.resolve(bins[bin] ?? true),
  };
}

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'cron-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-cron-'));
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

describe('cron codec', () => {
  it('parses tagged lines and rejects the rest', () => {
    expect(parseCronLine('*/5 * * * * /bin/true # panel:ab12cd34:nightly')).toEqual({
      id: 'ab12cd34',
      name: 'nightly',
      schedule: '*/5 * * * *',
      command: '/bin/true',
      enabled: true,
    });
    expect(parseCronLine('#*/5 * * * * /bin/true # panel:ab12cd34:nightly')?.enabled).toBe(false);
    expect(parseCronLine('  #  */5 * * * * /bin/true # panel:ff00:my job  ')?.name).toBe('my job');
    expect(parseCronLine('MAILTO=ops@example.com')).toBeNull();
    expect(parseCronLine('*/5 * * * * /bin/true')).toBeNull();
    expect(parseCronLine('* * * * /bin/true # panel:ab12:x')).toBeNull();
    expect(parseCronLine('# just a comment')).toBeNull();
  });

  it('renders and toggles exactly', () => {
    const line = cronJobLine({ schedule: '0 2 * * *', command: '/bin/sync', id: 'ab12', name: 'a\nb#c' });
    expect(line).toBe('0 2 * * * /bin/sync # panel:ab12:a b c');
    expect(parseCronLine(line)).toMatchObject({ id: 'ab12', name: 'a b c', enabled: true });
    expect(toggleCronLine(line, 'ab12')).toBe(`#${line}`);
    expect(toggleCronLine(`#${line}`, 'ab12')).toBe(line);
    expect(toggleCronLine(line, 'other')).toBe(line);
    expect(toggleCronLine('MAILTO=x', 'ab12')).toBe('MAILTO=x');
  });
});

describe('server cron routes', () => {
  it('gates with 401', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const backend = memoryBackend();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, cronBackend: backend });
    expect((await app.inject({ method: 'GET', url: '/api/cron/jobs' })).statusCode).toBe(401);
  });

  it('lists tagged jobs only, reports status', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const backend = memoryBackend(['MAILTO=x', '*/5 * * * * /bin/a # panel:aa11:first', '#0 1 * * * /bin/b # panel:bb22:second']);
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, cronBackend: backend });
    const cookie = await authedCookie(app);
    const jobs = await app.inject({ method: 'GET', url: '/api/cron/jobs', headers: { cookie } });
    expect(jobs.json()).toEqual({
      jobs: [
        { id: 'aa11', name: 'first', schedule: '*/5 * * * *', command: '/bin/a', enabled: true },
        { id: 'bb22', name: 'second', schedule: '0 1 * * *', command: '/bin/b', enabled: false },
      ],
    });
    const status = await app.inject({ method: 'GET', url: '/api/cron/status', headers: { cookie } });
    expect(status.json()).toEqual({ running: true });
  });

  it('validates adds and appends the exact line', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const backend = memoryBackend(['MAILTO=x']);
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, cronBackend: backend });
    const cookie = await authedCookie(app);
    const post = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/api/cron/jobs', headers: { cookie }, payload });

    expect((await post({ name: 'j', schedule: 'daily', command: '/bin/a' })).json().error).toBe('Schedule must have 5 cron fields');
    expect((await post({ name: 'j', schedule: '* * * * *', command: '  ' })).json().error).toBe('Command is required');

    const ok = await post({ schedule: '*/10 * * * *', command: '/bin/c' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().job).toMatchObject({ name: 'job', schedule: '*/10 * * * *', command: '/bin/c', enabled: true });
    expect(ok.json().job.id).toMatch(/^[0-9a-f]{8}$/);
    expect(backend.lines).toHaveLength(2);
    expect(backend.lines[1]).toMatch(/^\*\/10 \* \* \* \* \/bin\/c # panel:[0-9a-f]{8}:job$/);

    const missing = memoryBackend([], { crontab: false });
    const w2 = freshWorkspace();
    const { app: app2 } = buildServer({
      dataDir: w2.dataDir,
      legacyDir: w2.legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root: w2.root,
      cronBackend: missing,
    });
    const cookie2 = await authedCookie(app2);
    const denied = await app2.inject({
      method: 'POST',
      url: '/api/cron/jobs',
      headers: { cookie: cookie2 },
      payload: { name: 'j', schedule: '* * * * *', command: '/bin/a' },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toBe('crontab is not available on this system');
  });

  it('toggles both ways and ignores unknown ids', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const backend = memoryBackend(['*/5 * * * * /bin/a # panel:aa11:first', 'MAILTO=x']);
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, cronBackend: backend });
    const cookie = await authedCookie(app);

    expect((await app.inject({ method: 'POST', url: '/api/cron/jobs/aa11/toggle', headers: { cookie } })).json()).toEqual({ ok: true });
    expect(backend.lines[0]).toBe('#*/5 * * * * /bin/a # panel:aa11:first');
    expect((await app.inject({ method: 'POST', url: '/api/cron/jobs/aa11/toggle', headers: { cookie } })).json()).toEqual({ ok: true });
    expect(backend.lines[0]).toBe('*/5 * * * * /bin/a # panel:aa11:first');

    const before = [...backend.lines];
    expect((await app.inject({ method: 'POST', url: '/api/cron/jobs/zz99/toggle', headers: { cookie } })).json()).toEqual({ ok: true });
    expect(backend.lines).toEqual(before);
  });

  it('deletes by id while keeping foreign lines', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const backend = memoryBackend(['MAILTO=x', '*/5 * * * * /bin/a # panel:aa11:first', '0 1 * * * /bin/b # panel:bb22:second']);
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, cronBackend: backend });
    const cookie = await authedCookie(app);
    expect((await app.inject({ method: 'DELETE', url: '/api/cron/jobs/aa11', headers: { cookie } })).json()).toEqual({ ok: true });
    expect(backend.lines).toEqual(['MAILTO=x', '0 1 * * * /bin/b # panel:bb22:second']);
  });

  it('controls the service with bin gate', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const backend = memoryBackend([], { crond: true });
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, cronBackend: backend });
    const cookie = await authedCookie(app);
    expect((await app.inject({ method: 'POST', url: '/api/cron/service', headers: { cookie }, payload: { action: 'start' } })).json()).toEqual({ ok: true });
    expect(backend.spawns).toEqual([{ cmd: 'crond', args: [] }]);
    expect((await app.inject({ method: 'POST', url: '/api/cron/service', headers: { cookie }, payload: { action: 'stop' } })).json()).toEqual({ ok: true });
    expect(backend.execs.map((e) => e.cmd)).toContain('pkill -x crond');
    const unknown = await app.inject({ method: 'POST', url: '/api/cron/service', headers: { cookie }, payload: { action: 'bounce' } });
    expect(unknown.statusCode).toBe(400);

    const missing = memoryBackend([], { crond: false });
    const w2 = freshWorkspace();
    const { app: app2 } = buildServer({
      dataDir: w2.dataDir,
      legacyDir: w2.legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root: w2.root,
      cronBackend: missing,
    });
    const cookie2 = await authedCookie(app2);
    const denied = await app2.inject({ method: 'POST', url: '/api/cron/service', headers: { cookie: cookie2 }, payload: { action: 'start' } });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toMatch(/Install Cronie/);
  });
});
