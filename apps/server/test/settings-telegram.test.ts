import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from '@olp/env-core';
import { hashPassword } from '@olp/auth';
import type { SysDeps } from '@olp/sysinfo';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { botReply, formatUptime } from '../src/telegram.js';
import { resolveBind, validateBind } from '../src/settings.js';
import type { BotStatus, TelegramApi, TelegramUpdate } from '../src/telegram.js';
import type { Settings, TelegramSettings } from '../src/settings.js';

const KNOWN_PASSWORD = 'settingspass1';

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

function memorySettings(initial?: Partial<TelegramSettings>): {
  readonly saved: number;
  store: { load(): Settings; save(s: Settings): void };
} {
  let telegram: TelegramSettings = {
    botToken: '',
    chatId: '',
    enabled: false,
    commandsEnabled: true,
    ...initial,
  };
  let saved = 0;
  return {
    get saved() {
      return saved;
    },
    store: {
      load: (): Settings => ({ telegram: { ...telegram } }),
      save: (next: Settings): void => {
        telegram = { ...next.telegram };
        saved++;
      },
    },
  };
}

function makeApi(
  pages: TelegramUpdate[][] = [],
  opts: { sendError?: string } = {},
): TelegramApi & { sent: Array<{ chatId: string; text: string }>; getCalls: number } {
  const sent: Array<{ chatId: string; text: string }> = [];
  const queue = pages.map((page) => [...page]);
  const api = {
    sent,
    getCalls: 0,
    sendMessage: (_token: string, chatId: string, text: string): Promise<void> => {
      if (opts.sendError !== undefined) return Promise.reject(new Error(opts.sendError));
      sent.push({ chatId, text });
      return Promise.resolve();
    },
    getUpdates: (): Promise<TelegramUpdate[]> => {
      api.getCalls++;
      return Promise.resolve(queue.shift() ?? []);
    },
  };
  return api;
}

function quietDeps(): SysDeps {
  return {
    cpus: () => [{}, {}],
    loadavg: () => [0.5, 0.25, 0.1],
    totalmem: () => 2000,
    freemem: () => 1000,
    hostname: () => 'tg-box',
    uptime: () => 3661,
    exec: (cmd) =>
      cmd.startsWith('df')
        ? Promise.resolve('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 2000 500 1500 25% /\n')
        : Promise.reject(new Error('unused')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
  };
}

function freshWorkspace(): { dataDir: string; legacyDir: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'olp-settings-'));
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

function demoStatus(): BotStatus {
  return {
    hostname: 'demo',
    uptime: 90061,
    cpu: { load1: 1.5, load5: 0.5, load15: 0.25, cores: 4 },
    mem: { total: 200 * 1048576, free: 50 * 1048576, used: 150 * 1048576, percent: 75 },
    disk: { percent: 25 },
    battery: { percentage: 87, status: 'CHARGING' },
    sites: [
      { name: 'web', type: 'node', port: 3000, running: true },
      { name: 'blog', type: 'php', port: 4000, running: false },
    ],
  };
}

describe('telegram pure helpers', () => {
  it('formats uptime in English units', () => {
    expect(formatUptime(0)).toBe('0m');
    expect(formatUptime(90)).toBe('1m');
    expect(formatUptime(3661)).toBe('1h 1m');
    expect(formatUptime(90061)).toBe('1d 1h 1m');
  });

  it('answers every command', () => {
    const status = demoStatus();
    expect(botReply(status, '/help')).toContain('/status summary');
    expect(botReply(status, '/status')).toContain('demo | ⏱ 1d 1h 1m');
    expect(botReply(status, '/status')).toContain('RAM 150/200 MB (75%)');
    expect(botReply(status, '/status')).toContain('🔋 87%');
    expect(botReply(status, '/status')).toContain('1/2 running');
    expect(botReply(status, '/ram')).toContain('Total 200 MB');
    expect(botReply(status, '/cpu')).toContain('(4 core)');
    expect(botReply(status, '/battery')).toContain('87% (CHARGING)');
    expect(botReply(status, '/bat')).toContain('87% (CHARGING)');
    expect(botReply(status, '/sites')).toContain('🟢 web (node) :3000');
    expect(botReply(status, '/sites')).toContain('🔴 blog (php) :4000');
    expect(botReply(status, '/nope')).toBe('Unknown command. Type /help.');
  });

  it('degrades battery and disk gracefully', () => {
    const status: BotStatus = { ...demoStatus(), disk: null, battery: { error: 'unavailable' } };
    expect(botReply(status, '/status')).toContain('n/a');
    expect(botReply(status, '/battery')).toContain('unavailable');
    expect(botReply({ ...demoStatus(), sites: [] }, '/sites')).toBe('No websites yet');
  });
});

describe('server settings routes', () => {
  it('gates with 401', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const settings = memorySettings();
    const api = makeApi();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, settingsStore: settings.store, telegramApi: api });
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401);
  });

  it('reads defaults, saves normalized, and reflects live username', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const settings = memorySettings();
    const api = makeApi();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, settingsStore: settings.store, telegramApi: api });
    const cookie = await authedCookie(app);

    const get = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(get.json()).toMatchObject({
      username: 'tester',
      telegram: { botToken: '', chatId: '', enabled: false, commandsEnabled: true },
      version: '2.0.0-alpha.1',
    });

    const save = await app.inject({
      method: 'POST',
      url: '/api/settings',
      headers: { cookie },
      payload: { telegram: { botToken: 'tok', chatId: '123', enabled: true } },
    });
    expect(save.json()).toEqual({ ok: true });
    expect(settings.saved).toBe(1);
    const get2 = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(get2.json().telegram).toEqual({ botToken: 'tok', chatId: '123', enabled: true, commandsEnabled: true });

    await app.inject({
      method: 'POST',
      url: '/api/auth/change-username',
      headers: { cookie },
      payload: { username: 'ops2' },
    });
    const get3 = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(get3.json().username).toBe('ops2');
  });

  it('tests delivery with 400 shapes', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const settings = memorySettings();
    const api = makeApi();
    const { app } = buildServer({ dataDir, legacyDir, env: fakeEnv, sysDeps: quietDeps(), root, settingsStore: settings.store, telegramApi: api });
    const cookie = await authedCookie(app);

    const off = await app.inject({ method: 'POST', url: '/api/settings/test-telegram', headers: { cookie } });
    expect(off.statusCode).toBe(400);
    expect(off.json()).toEqual({ ok: false, error: 'Fill in bot token & chat ID and enable it first' });

    settings.store.save({ telegram: { botToken: 'tok', chatId: '123', enabled: true, commandsEnabled: true } });
    const ok = await app.inject({ method: 'POST', url: '/api/settings/test-telegram', headers: { cookie } });
    expect(ok.json()).toEqual({ ok: true });
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.text).toBe('OLP notification test successful!');

    const failing = makeApi([], { sendError: 'Bad token' });
    const w2 = freshWorkspace();
    const settings2 = memorySettings({ botToken: 'bad', chatId: '123', enabled: true });
    const { app: app2 } = buildServer({
      dataDir: w2.dataDir,
      legacyDir: w2.legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root: w2.root,
      settingsStore: settings2.store,
      telegramApi: failing,
    });
    const cookie2 = await authedCookie(app2);
    const bad = await app2.inject({ method: 'POST', url: '/api/settings/test-telegram', headers: { cookie: cookie2 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ ok: false, error: 'Bad token' });
  });

  it('serves bind info and telegram identity states', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const settings = memorySettings();
    const api = makeApi();
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      settingsStore: settings.store,
      telegramApi: api,
      settingsBotUsername: () => Promise.resolve('TerwoNodeBot'),
    });
    const cookie = await authedCookie(app);
    const get = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    const bind = get.json().bind as { host: unknown; port: unknown; loopback: unknown };
    expect(typeof bind.host).toBe('string');
    expect(typeof bind.port).toBe('number');
    expect(typeof bind.loopback).toBe('boolean');

    expect((await app.inject({ method: 'GET', url: '/api/settings/telegram/identity', headers: { cookie } })).json()).toEqual({
      username: 'TerwoNodeBot',
    });
    expect((await app.inject({ method: 'GET', url: '/api/settings/telegram/identity' })).statusCode).toBe(401);
  });

  it('answers identity null without a thunk or on failure', async () => {    const w1 = freshWorkspace();
    const { app } = buildServer({
      dataDir: w1.dataDir,
      legacyDir: w1.legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root: w1.root,
      settingsStore: memorySettings().store,
      telegramApi: makeApi(),
    });
    const cookie = await authedCookie(app);
    expect((await app.inject({ method: 'GET', url: '/api/settings/telegram/identity', headers: { cookie } })).json()).toEqual({
      username: null,
    });

    const w2 = freshWorkspace();
    const { app: app2 } = buildServer({
      dataDir: w2.dataDir,
      legacyDir: w2.legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root: w2.root,
      settingsStore: memorySettings().store,
      telegramApi: makeApi(),
      settingsBotUsername: () => Promise.reject(new Error('offline')),
    });
    const cookie2 = await authedCookie(app2);
    expect((await app2.inject({ method: 'GET', url: '/api/settings/telegram/identity', headers: { cookie: cookie2 } })).json()).toEqual({
      username: null,
    });
  });

  it('resolves bind from boot env keys with safe defaults', async () => {
    const { currentBind } = await import('../src/settings.js');
    const savedHost = process.env['PANEL_HOST'];
    const savedPort = process.env['PANEL_PORT'];
    try {
      delete process.env['PANEL_HOST'];
      delete process.env['PANEL_PORT'];
      expect(currentBind()).toEqual({ host: '127.0.0.1', port: 8080, loopback: true });
      process.env['PANEL_HOST'] = '0.0.0.0';
      process.env['PANEL_PORT'] = '1899';
      expect(currentBind()).toEqual({ host: '0.0.0.0', port: 1899, loopback: false });
      process.env['PANEL_PORT'] = 'junk';
      expect(currentBind().port).toBe(8080);
    } finally {
      if (savedHost === undefined) delete process.env['PANEL_HOST'];
      else process.env['PANEL_HOST'] = savedHost;
      if (savedPort === undefined) delete process.env['PANEL_PORT'];
      else process.env['PANEL_PORT'] = savedPort;
    }
  });
});

describe('server telegram bot', () => {
  function rig(pages: TelegramUpdate[][] = [], initial?: Partial<TelegramSettings>) {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const settings = memorySettings(initial);
    const api = makeApi(pages);
    const handle = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      settingsStore: settings.store,
      telegramApi: api,
    });
    return { app: handle.app, bot: handle.telegram.bot, api };
  }

  it('answers allowlisted chats and advances offsets', async () => {
    const { bot, api } = rig(
      [
        [
          { update_id: 10, message: { chat: { id: 123 }, text: '/status' } },
          { update_id: 11, message: { chat: { id: 999 }, text: '/status' } },
          { update_id: 12, message: { chat: { id: 123 } } },
          { update_id: 13, message: { chat: { id: '123' }, text: '/ram@OlpBot extra args' } },
        ],
      ],
      { botToken: 'tok', chatId: '123', enabled: true },
    );
    await bot.pollOnce();
    expect(api.sent).toHaveLength(2);
    expect(api.sent[0]?.text).toContain('tg-box');
    expect(api.sent[1]?.text).toContain('Total');
    expect(bot.currentOffset).toBe(14);
  });

  it('short-circuits when disabled and drains history', async () => {
    const off = rig([[{ update_id: 3, message: { chat: { id: 123 }, text: '/status' } }]]);
    await off.bot.pollOnce();
    expect(off.api.getCalls).toBe(0);
    expect(off.api.sent).toHaveLength(0);

    const on = rig(
      [[{ update_id: 5, message: { chat: { id: 123 }, text: '/status' } }, { update_id: 7, message: { chat: { id: 123 }, text: '/cpu' } }]],
      { botToken: 'tok', chatId: '123', enabled: true },
    );
    await on.bot.drain();
    expect(on.bot.currentOffset).toBe(8);
    expect(on.api.sent).toHaveLength(0);
    await on.bot.pollOnce();
    expect(on.api.sent).toHaveLength(0);
  });

  it('notifies install finishes through live settings', async () => {
    const { dataDir, legacyDir, root } = freshWorkspace();
    const settings = memorySettings({ botToken: 'tok', chatId: '123', enabled: true });
    const api = makeApi();
    let doneCb: ((code: number | null, err: Error | null) => void) | null = null;
    const { app } = buildServer({
      dataDir,
      legacyDir,
      env: fakeEnv,
      sysDeps: quietDeps(),
      root,
      settingsStore: settings.store,
      telegramApi: api,
      storeCheck: () => Promise.resolve(false),
      storeSpawn: (cmd, _cwd, onData, onDone) => {
        void cmd;
        void onData;
        doneCb = onDone;
        return { kill: () => {} };
      },
    });
    const cookie = await authedCookie(app);
    await app.inject({ method: 'POST', url: '/api/install/redis/start', headers: { cookie } });
    doneCb?.(0, null);
    await new Promise((r) => setTimeout(r, 50));
    expect(api.sent.at(-1)?.text).toBe('✅ Install Redis finished (exit 0)');
  });
});

describe('server bind resolve and validate', () => {
  it('validates hosts and ports with naming errors', () => {
    expect(validateBind('127.0.0.1', 8080)).toEqual({ ok: true, bind: { host: '127.0.0.1', port: 8080 } });
    expect(validateBind('::1', 9090)).toEqual({ ok: true, bind: { host: '::1', port: 9090 } });
    expect(validateBind('panel.lan', 8080).ok).toBe(true);
    expect(validateBind('', 8080)).toMatchObject({ ok: false });
    expect(validateBind('has space', 8080).ok).toBe(false);
    expect(validateBind('127.0.0.1; rm -rf', 8080).ok).toBe(false);
    expect(validateBind('127.0.0.1', 80)).toMatchObject({ ok: false, error: expect.stringContaining('1024') });
    expect(validateBind('127.0.0.1', 80.5).ok).toBe(false);
    expect(validateBind('127.0.0.1', 99999).ok).toBe(false);
    expect(validateBind('127.0.0.1', '8080').ok).toBe(false);
  });

  it('resolves env over file over default with fall-through', () => {
    expect(resolveBind({}, null)).toEqual({ bind: { host: '127.0.0.1', port: 8080 }, source: 'default' });
    expect(resolveBind({ PANEL_HOST: '0.0.0.0', PANEL_PORT: '9090' }, { host: '127.0.0.1', port: 7070 })).toEqual({
      bind: { host: '0.0.0.0', port: 9090 },
      source: 'env',
    });
    expect(resolveBind({ PANEL_PORT: '9090' }, null)).toEqual({ bind: { host: '127.0.0.1', port: 9090 }, source: 'env' });
    expect(resolveBind({}, { host: '127.0.0.1', port: 7070 })).toEqual({
      bind: { host: '127.0.0.1', port: 7070 },
      source: 'file',
    });
    // Invalid values fall through instead of crashing boot.
    expect(resolveBind({ PANEL_HOST: 'has space', PANEL_PORT: '80' }, { host: '127.0.0.1', port: 7070 })).toMatchObject({
      source: 'file',
    });
    expect(resolveBind({ PANEL_HOST: 'has space' }, { host: 'nope nope', port: 1 })).toMatchObject({ source: 'default' });
    expect(resolveBind({ PANEL_PORT: 'junk' }, null)).toMatchObject({ source: 'default' });
  });
});
