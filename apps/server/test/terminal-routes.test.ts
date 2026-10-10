import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildServer } from '../src/index.js';
import type { ServerHandle } from '../src/index.js';
import type { TermBackend, TermBackendFactory } from '../src/terminal.js';

const KNOWN_PASSWORD = 'termpass1';

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

class FakeBackend implements TermBackend {
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  private outputCb: (chunk: string) => void = () => {};
  private exitCb: () => void = () => {};

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {}

  onOutput(cb: (chunk: string) => void): void {
    this.outputCb = cb;
  }

  onExit(cb: () => void): void {
    this.exitCb = cb;
  }

  emit(chunk: string): void {
    this.outputCb(chunk);
  }
}

function fakeFactory(backends: FakeBackend[], pty: boolean): TermBackendFactory {
  return {
    createPty: () => {
      if (!pty) return null;
      const backend = new FakeBackend();
      backends.push(backend);
      return backend;
    },
    createPipe: () => {
      const backend = new FakeBackend();
      backends.push(backend);
      return backend;
    },
  };
}

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}],
    loadavg: () => [0, 0, 0],
    totalmem: () => 1000,
    freemem: () => 1000,
    hostname: () => 'term-box',
    uptime: () => 10,
    exec: () => Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

async function liveServer(termFactory: TermBackendFactory): Promise<{
  app: FastifyInstance;
  terminal: ServerHandle['terminal'];
  port: number;
  cookie: string;
}> {
  const base = mkdtempSync(join(tmpdir(), 'olp-term-'));
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
  const { app, terminal } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, termFactory });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'tester', password: KNOWN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const raw = login.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : (raw as string);
  return { app, terminal, port, cookie: (first ?? '').split(';')[0] ?? '' };
}

/** Collect socket text until `pred` matches or the timeout elapses. */
function waitForText(ws: WebSocket, pred: (text: string) => boolean, timeoutMs = 5000): Promise<string> {
  let acc = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeAllListeners('message');
      reject(new Error(`timed out waiting for socket text (got ${JSON.stringify(acc.slice(0, 200))})`));
    }, timeoutMs);
    ws.on('message', (data) => {
      acc += data.toString();
      if (pred(acc)) {
        clearTimeout(timer);
        ws.removeAllListeners('message');
        resolve(acc);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('server terminal route', () => {
  it('greets, relays input, resizes, and detaches on close', async () => {
    const backends: FakeBackend[] = [];
    const { app, terminal, port, cookie } = await liveServer(fakeFactory(backends, true));
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/term`, { headers: { cookie } });
      const greeting = await waitForText(ws, (t) => t.includes('Terminal ready'));
      expect(greeting).toMatch(/Terminal ready \(.+, pty\)/);
      expect(backends.length).toBe(1);

      ws.send(JSON.stringify({ t: 'in', d: 'hello\n' }));
      ws.send('rawkeys');
      ws.send(JSON.stringify({ t: 'rs', c: 100, r: 30 }));
      await new Promise((r) => setTimeout(r, 400));
      expect(backends[0]?.written).toContain('hello\n');
      expect(backends[0]?.written).toContain('rawkeys');
      expect(backends[0]?.resizes).toEqual([[100, 30]]);

      // backend output reaches the socket
      const seen = waitForText(ws, (t) => t.includes('shell-says-hi'));
      backends[0]?.emit('shell-says-hi');
      await expect(seen).resolves.toContain('shell-says-hi');

      ws.close();
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      terminal.shutdown();
      await app.close();
    }
  });

  it('announces pipe mode when pty is unavailable', async () => {
    const backends: FakeBackend[] = [];
    const { app, terminal, port, cookie } = await liveServer(fakeFactory(backends, false));
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/term`, { headers: { cookie } });
      const greeting = await waitForText(ws, (t) => t.includes('Terminal ready'));
      expect(greeting).toMatch(/, pipe\)/);
      ws.close();
    } finally {
      terminal.shutdown();
      await app.close();
    }
  });

  it('closes upgrades without a session', async () => {
    const backends: FakeBackend[] = [];
    const { app, terminal, port } = await liveServer(fakeFactory(backends, true));
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/term`);
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 4000);
        ws.on('close', () => {
          clearTimeout(timer);
          resolve(true);
        });
        ws.on('error', () => {});
      });
      expect(closed).toBe(true);
      expect(backends.length).toBe(0);
    } finally {
      terminal.shutdown();
      await app.close();
    }
  });

  it.skipIf(process.platform === 'win32')('drives a real pipe shell end to end', async () => {
    const base = mkdtempSync(join(tmpdir(), 'olp-termreal-'));
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
    // No termFactory: real backends (node-pty if built, else pipes).
    const { app, terminal } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = app.server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'tester', password: KNOWN_PASSWORD },
      });
      const raw = login.headers['set-cookie'];
      const first = Array.isArray(raw) ? raw[0] : (raw as string);
      const cookie = (first ?? '').split(';')[0] ?? '';
      const ws = new WebSocket(`ws://127.0.0.1:${port}/term`, { headers: { cookie } });
      await waitForText(ws, (t) => t.includes('Terminal ready'), 8000);
      ws.send('echo REALPIPEMARKER987\n');
      const out = await waitForText(ws, (t) => t.includes('REALPIPEMARKER987'), 8000);
      expect(out).toContain('REALPIPEMARKER987');
      ws.close();
    } finally {
      terminal.shutdown();
      await app.close();
    }
  }, 20000);
});
