import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { relOf, safeName, safePath } from '../src/files.js';
import { buildServer } from '../src/index.js';

const KNOWN_PASSWORD = 'filespass1';

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

interface ExecCall {
  cmd: string;
}

/** Fake shell: df works, archive bins present, everything recorded. */
function makeExec(opts: { haveZip?: boolean; haveUnzip?: boolean } = {}): {
  fn: SysDeps['exec'];
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const haveZip = opts.haveZip ?? true;
  const haveUnzip = opts.haveUnzip ?? true;
  const fn: SysDeps['exec'] = (cmd) => {
    calls.push({ cmd });
    if (cmd.startsWith('df')) {
      return Promise.resolve('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 2000 500 1500 25% /\n');
    }
    if (cmd.startsWith('command -v zip')) {
      return haveZip ? Promise.resolve('/usr/bin/zip\n') : Promise.reject(new Error('not found'));
    }
    if (cmd.startsWith('command -v unzip')) {
      return haveUnzip ? Promise.resolve('/usr/bin/unzip\n') : Promise.reject(new Error('not found'));
    }
    if (cmd.startsWith('zip -rq') || cmd.startsWith('unzip -o')) return Promise.resolve('');
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  };
  return { fn, calls };
}

function fakeDeps(exec: SysDeps['exec']): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'files-box',
    uptime: () => 10,
    exec,
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-files-'));
  const dataDir = join(base, 'data');
  const legacyDir = join(base, 'legacy');
  const root = join(base, 'root');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join((mkdirSync(dataDir, { recursive: true }), dataDir), 'config.json'),
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

function authedServer(execOpts?: { haveZip?: boolean; haveUnzip?: boolean }): {
  app: FastifyInstance;
  cookie: Promise<string>;
  calls: ExecCall[];
  root: string;
} {
  const { dataDir, legacyDir, root } = freshWorkspace();
  const { fn, calls } = makeExec(execOpts);
  const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps(fn), root });
  return { app, cookie: authedCookie(app), calls, root };
}

describe('safePath / safeName / relOf', () => {
  it('resolves inside root and rejects escapes', () => {
    const root = join(tmpdir(), 'olp-jail');
    expect(safePath(root, '')).toBe(root);
    expect(safePath(root, 'a/b')).toBe(join(root, 'a/b'));
    expect(() => safePath(root, '..')).toThrow(/outside working directory/);
    expect(() => safePath(root, 'a/../../..')).toThrow(/outside working directory/);
    expect(() => safePath(root, '/etc')).toThrow(/outside working directory/);
  });

  it('validates single segments', () => {
    expect(safeName('ok-name_1.txt')).toBe('ok-name_1.txt');
    expect(safeName('  spaced  ')).toBe('spaced');
    for (const bad of ['', '  ', '.', '..', 'a/b', 'a\\b', 'a\0b', 42, undefined]) {
      expect(() => safeName(bad)).toThrow(/Invalid name/);
    }
  });

  it('relativizes with empty string for root', () => {
    const root = join(tmpdir(), 'olp-jail');
    expect(relOf(root, root)).toBe('');
    expect(relOf(root, join(root, 'sub'))).toBe('sub');
  });
});

describe('server files routes', () => {
  it('gates /api/files with 401', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const { fn } = makeExec();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: fakeDeps(fn), root });
    const res = await app.inject({ method: 'GET', url: '/api/files?path=' });
    expect(res.statusCode).toBe(401);
  });

  it('lists dirs-first sorted and rejects traversal', async () => {
    const { app, cookie, root } = authedServer();
    const c = await cookie;
    mkdirSync(join(root, 'bdir'), { recursive: true });
    mkdirSync(join(root, 'adir'), { recursive: true });
    writeFileSync(join(root, 'z.txt'), 'z');
    writeFileSync(join(root, 'a.txt'), 'a');
    const res = await app.inject({ method: 'GET', url: '/api/files?path=', headers: { cookie: c } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      path: '',
      entries: [
        { name: 'adir', type: 'dir' },
        { name: 'bdir', type: 'dir' },
        { name: 'a.txt', type: 'file', size: 1 },
        { name: 'z.txt', type: 'file', size: 1 },
      ],
    });
    const evil = await app.inject({ method: 'GET', url: '/api/files?path=' + encodeURIComponent('..'), headers: { cookie: c } });
    expect(evil.statusCode).toBe(400);
    expect(evil.json().error).toMatch(/outside working directory/);
  });

  it('mkdir touch rename delete round-trip without clobber', async () => {
    const { app, cookie } = authedServer();
    const c = await cookie;
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { cookie: c }, payload });

    expect((await post('/api/mkdir', { path: '', name: 'd' })).statusCode).toBe(200);
    expect((await post('/api/touch', { path: 'd', name: 'n.txt' })).statusCode).toBe(200);
    const write = await post('/api/write', { path: 'd', name: 'n.txt', content: 'v1' });
    expect(write.statusCode).toBe(200);
    // touch again must not clobber
    expect((await post('/api/touch', { path: 'd', name: 'n.txt' })).statusCode).toBe(200);
    const read = await post('/api/read', { path: 'd', name: 'n.txt' });
    expect(read.json()).toEqual({ ok: true, content: 'v1' });

    expect((await post('/api/rename', { path: 'd', from: 'n.txt', to: 'm.txt' })).statusCode).toBe(200);
    const read2 = await post('/api/read', { path: 'd', name: 'm.txt' });
    expect(read2.json()).toEqual({ ok: true, content: 'v1' });

    expect((await post('/api/delete', { path: 'd', name: 'm.txt' })).statusCode).toBe(200);
    const gone = await post('/api/read', { path: 'd', name: 'm.txt' });
    expect(gone.statusCode).toBe(400);
  });

  it('lists octal modes and chmods through the jail', async () => {
    const { app, cookie, root } = authedServer();
    const c = await cookie;
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { cookie: c }, payload });
    writeFileSync(join(root, 'm.txt'), 'm');
    const listed = await app.inject({ method: 'GET', url: '/api/files?path=', headers: { cookie: c } });
    const row = (listed.json() as { entries: Array<{ name: string; mode: unknown }> }).entries.find((e) => e.name === 'm.txt');
    expect(typeof row?.mode).toBe('string');
    expect(row?.mode).toMatch(/^[0-7]{4}$/);

    for (const bad of [{ path: '', name: 'm.txt', mode: '999' }, { path: '', name: 'm.txt', mode: 'abc' }, { path: '', name: 'm.txt', mode: '' }, { path: '', name: 'm.txt' }]) {
      const res = await post('/api/chmod', bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid mode (octal, e.g. 0644)');
    }
    expect((await post('/api/chmod', { path: '', name: 'nope.txt', mode: '0644' })).statusCode).toBe(400);
    expect((await post('/api/chmod', { path: '', name: 'm.txt', mode: '0600' })).json()).toEqual({ ok: true });
    expect(statSync(join(root, 'm.txt')).mode & 0o777).toBe(0o600);
    const relisted = await app.inject({ method: 'GET', url: '/api/files?path=', headers: { cookie: c } });
    expect((relisted.json() as { entries: Array<{ name: string; mode: unknown }> }).entries.find((e) => e.name === 'm.txt')?.mode).toBe('0600');
    expect((await app.inject({ method: 'POST', url: '/api/chmod', headers: { cookie: c }, payload: { path: '', name: 'm.txt', mode: '0644' } })).statusCode).toBe(200);

    symlinkSync(join(root, 'm.txt'), join(root, 'link.txt'));
    const link = await post('/api/chmod', { path: '', name: 'link.txt', mode: '0644' });
    expect(link.statusCode).toBe(400);
    expect(link.json().error).toBe('Symlinks cannot be chmodded');
    expect((await app.inject({ method: 'POST', url: '/api/chmod', payload: { path: '', name: 'm.txt', mode: '0644' } })).statusCode).toBe(401);
  });

  it('refuses oversized reads and non-string writes', async () => {
    const { app, cookie, root } = authedServer();
    const c = await cookie;
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(2 * 1024 * 1024));
    const read = await app.inject({ method: 'POST', url: '/api/read', headers: { cookie: c }, payload: { path: '', name: 'big.txt' } });
    expect(read.statusCode).toBe(400);
    expect(read.json().error).toMatch(/max 1 MB/);
    const write = await app.inject({ method: 'POST', url: '/api/write', headers: { cookie: c }, payload: { path: '', name: 'w.txt', content: 42 } });
    expect(write.statusCode).toBe(400);
    expect(write.json().error).toBe('Invalid content');
  });

  it('uploads base64 and downloads with attachment headers', async () => {
    const { app, cookie } = authedServer();
    const c = await cookie;
    const data = Buffer.from('hello-files').toString('base64');
    const up = await app.inject({ method: 'POST', url: '/api/upload', headers: { cookie: c }, payload: { path: '', name: 'u.bin', data } });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toEqual({ ok: true, size: 11 });

    const down = await app.inject({ method: 'GET', url: '/api/download?path=&name=u.bin', headers: { cookie: c } });
    expect(down.statusCode).toBe(200);
    expect(down.headers['content-type']).toBe('application/octet-stream');
    expect(down.headers['content-disposition']).toBe('attachment; filename="u.bin"');
    expect(down.body).toBe('hello-files');
  });

  it('zips with exact command shape and refuses root', async () => {
    const { app, cookie, calls, root } = authedServer();
    const c = await cookie;
    mkdirSync(join(root, 'site'), { recursive: true });
    writeFileSync(join(root, 'site', 'index.html'), '<h1>hi</h1>');
    const res = await app.inject({ method: 'POST', url: '/api/files/zip', headers: { cookie: c }, payload: { path: 'site' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, zipPath: 'site.zip' });
    expect(calls.map((x) => x.cmd)).toEqual([
      `command -v zip >/dev/null 2>&1`,
      `zip -rq '${join(root, 'site')}.zip' 'site'`,
    ]);
    const refuse = await app.inject({ method: 'POST', url: '/api/files/zip', headers: { cookie: c }, payload: { path: '' } });
    expect(refuse.statusCode).toBe(400);
    expect(refuse.json().error).toBe('Cannot zip root');
  });

  it('reports missing zip bin with the Store hint', async () => {
    const { app, cookie } = authedServer({ haveZip: false });
    const c = await cookie;
    const res = await app.inject({ method: 'POST', url: '/api/files/zip', headers: { cookie: c }, payload: { path: 'whatever' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Package "zip" is not installed/);
  });

  it('unzips .zip only with exact command shape', async () => {
    const { app, cookie, calls, root } = authedServer();
    const c = await cookie;
    writeFileSync(join(root, 'a.zip'), 'fakezip');
    const res = await app.inject({ method: 'POST', url: '/api/files/unzip', headers: { cookie: c }, payload: { path: 'a.zip' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(calls.map((x) => x.cmd)).toEqual([
      `command -v unzip >/dev/null 2>&1`,
      `unzip -o '${join(root, 'a.zip')}' -d '${root}'`,
    ]);
    writeFileSync(join(root, 'a.txt'), 'x');
    const bad = await app.inject({ method: 'POST', url: '/api/files/unzip', headers: { cookie: c }, payload: { path: 'a.txt' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('Not a zip file');
  });

  it('previews images only within size cap', async () => {
    const { app, cookie, root } = authedServer();
    const c = await cookie;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(root, 'i.png'), png);
    writeFileSync(join(root, 't.txt'), 'text');
    const ok = await app.inject({ method: 'GET', url: '/api/files/preview?path=i.png', headers: { cookie: c } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    const txt = await app.inject({ method: 'GET', url: '/api/files/preview?path=t.txt', headers: { cookie: c } });
    expect(txt.statusCode).toBe(400);
    expect(txt.json().error).toBe('Preview supports images only');
    const missing = await app.inject({ method: 'GET', url: '/api/files/preview?path=no.png', headers: { cookie: c } });
    expect(missing.statusCode).toBe(400);
  });
});
