import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { detect } from '@olp/env-core';
import type { Environment } from '@olp/env-core';
import type { SysDeps } from '@olp/sysinfo';
import { createAuthContext, registerAuthRoutes, resolveDirs } from './auth.js';
import type { AuthContext } from './auth.js';
import { nodeDeps, registerStatsRoutes } from './stats.js';
import { registerFilesRoutes } from './files.js';
import { TerminalManager, realBackendFactory, registerTerminalRoutes } from './terminal.js';
import type { TermBackendFactory } from './terminal.js';
import { fileSiteStore, realSpawner, registerSitesRoutes } from './sites.js';
import type { SiteSpawner, SiteStore } from './sites.js';
import { createSiteRuntime } from './sites.js';
import { fileProxyStore, nodeProxySys, registerProxyRoutes } from './proxy.js';
import type { ProxyStore, ProxySystem } from './proxy.js';
import { fileRegistry, mysqlDriver, normalizeConfig, pgDriver, registerDatabaseRoutes } from './database.js';
import type { DbConfig, DbDriver, DbEngine, DbRegistry } from './database.js';
import { nodeBackupSys, registerBackupRoutes } from './backup.js';
import type { BackupSystem } from './backup.js';
import { nodeCronBackend, registerCronRoutes } from './cron.js';
import type { CronBackend } from './cron.js';
import { realSpawnShell, registerStoreRoutes } from './store.js';
import type { SpawnShell } from './store.js';
import { fileSettingsStore, registerSettingsRoutes } from './settings.js';
import type { SettingsStore } from './settings.js';
import { TelegramBot, nodeTelegramApi } from './telegram.js';
import type { BotStatus, TelegramApi } from './telegram.js';
import { getSystemInfo } from '@olp/sysinfo';
import { sessionTokenFromHeader } from '@olp/auth';

/** Server version (single source of truth for health/settings payloads). */
export const SERVER_VERSION = '2.0.0-alpha.0';

/** Configured server plus its auth state (routes mutate `auth`). */
export interface ServerHandle {
  app: FastifyInstance;
  auth: AuthContext;
  env: Environment;
  terminal: TerminalManager;
  telegram: { bot: TelegramBot; startPoller: () => void; stopPoller: () => void };
}

/** Injectable server inputs (tests pass fakes; production uses defaults). */
export interface ServerOptions {
  dataDir?: string;
  legacyDir?: string;
  env?: Environment;
  sysDeps?: SysDeps;
  root?: string;
  termFactory?: TermBackendFactory;
  siteStore?: SiteStore;
  siteSpawner?: SiteSpawner;
  proxyStore?: ProxyStore;
  proxySys?: ProxySystem;
  dbRegistry?: DbRegistry;
  dbDrivers?: Record<DbEngine, DbDriver>;
  backupSys?: BackupSystem;
  backupDbConfig?: (engine: 'mysql' | 'postgres') => DbConfig;
  cronBackend?: CronBackend;
  storeCheck?: (cmd: string) => Promise<boolean>;
  storeSpawn?: SpawnShell;
  storeNotify?: (text: string) => void;
  settingsStore?: SettingsStore;
  telegramApi?: TelegramApi;
}

/**
 * Create and configure the OLP API server.
 *
 * Public probes (`/healthz`, `/api/health`, `POST /api/login`) bypass
 * auth; every other `/api/*` route requires a valid `tpsid` session.
 * Pass explicit dirs in tests to avoid touching the real home directory.
 */
export function buildServer(opts: ServerOptions = {}): ServerHandle {
  const resolved = resolveDirs();
  const dataDir = opts.dataDir ?? resolved.dataDir;
  const legacyDir = opts.legacyDir ?? resolved.legacyDir;
  const env = opts.env ?? detect();
  const sysDeps = opts.sysDeps ?? nodeDeps();
  const root = opts.root ?? process.env['PANEL_ROOT'] ?? homedir();
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true, service: 'olp' }));
  app.get('/api/health', async () => ({
    ok: true,
    service: 'olp',
    version: SERVER_VERSION,
  }));

  const auth = createAuthContext(dataDir, legacyDir);
  registerAuthRoutes(app, auth);
  registerStatsRoutes(app, { env, deps: sysDeps, root });
  registerFilesRoutes(app, { root, exec: sysDeps.exec });
  const siteStore = opts.siteStore ?? fileSiteStore(auth.dataDir);
  const siteRuntime = createSiteRuntime();
  registerSitesRoutes(app, {
    root,
    store: siteStore,
    spawner: opts.siteSpawner ?? realSpawner(),
    runtime: siteRuntime,
  });
  registerProxyRoutes(app, {
    dataDir: auth.dataDir,
    sitesDir: join(auth.dataDir, 'nginx', 'sites'),
    prefix: env.prefix,
    store: opts.proxyStore ?? fileProxyStore(auth.dataDir),
    sys: opts.proxySys ?? nodeProxySys(),
  });
  const dbRegistry = opts.dbRegistry ?? fileRegistry(auth.dataDir);
  registerDatabaseRoutes(app, {
    registry: dbRegistry,
    drivers: opts.dbDrivers ?? { mysql: mysqlDriver(), postgres: pgDriver() },
  });
  registerBackupRoutes(app, {
    dataDir: auth.dataDir,
    root,
    sys: opts.backupSys ?? nodeBackupSys(),
    dbConfig: opts.backupDbConfig ?? ((engine) => normalizeConfig(engine, (dbRegistry.load()[engine] ?? {}) as Record<string, unknown>)),
  });
  registerCronRoutes(app, { backend: opts.cronBackend ?? nodeCronBackend() });
  const settingsStore = opts.settingsStore ?? fileSettingsStore(auth.dataDir);
  const telegramApi = opts.telegramApi ?? nodeTelegramApi();
  const botStatus = async (): Promise<BotStatus> => {
    const info = await getSystemInfo(env, sysDeps, root);
    return {
      hostname: info.hostname,
      uptime: info.uptime,
      cpu: info.cpu,
      mem: info.mem,
      disk: info.disk,
      battery: info.battery,
      sites: siteStore.list().map((site) => ({
        name: site.name,
        type: site.type,
        port: site.port,
        running: siteRuntime.running.has(site.id),
      })),
    };
  };
  const bot = new TelegramBot({
    settings: () => settingsStore.load().telegram,
    api: telegramApi,
    status: botStatus,
  });
  const notifyTelegram = (text: string): void => {
    try {
      const tg = settingsStore.load().telegram;
      if (!tg.enabled || tg.botToken === '' || tg.chatId === '') return;
      telegramApi.sendMessage(tg.botToken, tg.chatId, text).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.log('Telegram failed:', err instanceof Error ? err.message : String(err));
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log('Telegram failed:', err instanceof Error ? err.message : String(err));
    }
  };
  let pollTimer: NodeJS.Timeout | null = null;
  const stopPoller = (): void => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  const startPoller = (): void => {
    stopPoller();
    bot.drain().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.log('Telegram poll:', err instanceof Error ? err.message : String(err));
    });
    pollTimer = setInterval(() => {
      bot.pollOnce().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.log('Telegram poll:', err instanceof Error ? err.message : String(err));
      });
    }, 10000);
    pollTimer.unref();
  };
  registerSettingsRoutes(app, {
    store: settingsStore,
    username: () => auth.config.username,
    version: SERVER_VERSION,
    onTelegramConfig: () => {
      stopPoller();
      startPoller();
    },
    testSend: (tg) => telegramApi.sendMessage(tg.botToken, tg.chatId, 'OLP notification test successful!'),
  });
  registerStoreRoutes(app, {
    env: env.id,
    home: homedir(),
    check: opts.storeCheck,
    spawnShell: opts.storeSpawn ?? realSpawnShell,
    notify: opts.storeNotify ?? notifyTelegram,
  });
  const terminal = new TerminalManager({
    shell: process.env['SHELL'] ?? env.shell ?? 'sh',
    cwd: root,
    env: process.env,
    factory: opts.termFactory ?? realBackendFactory(),
  });
  registerTerminalRoutes(app, {
    manager: terminal,
    validate: (header) => auth.store.validate(sessionTokenFromHeader(header)),
  });
  app.setErrorHandler(async (err: Error, _req: FastifyRequest, reply: FastifyReply) => {
    reply.code(400);
    await reply.send({ error: err.message || 'Failed' });
  });
  return { app, auth, env, terminal, telegram: { bot, startPoller, stopPoller } };
}

/**
 * Start the server when executed directly (`node dist/index.js`).
 * Respects `PANEL_PORT` / `PANEL_HOST` for Terwo compat; defaults
 * to localhost-only per security posture.
 */
async function main(): Promise<void> {
  const port = Number.parseInt(process.env['PANEL_PORT'] ?? '8080', 10);
  const host = process.env['PANEL_HOST'] ?? '127.0.0.1';
  const { app, auth, telegram } = buildServer();
  if (auth.created && auth.plaintextPassword !== undefined) {
    // eslint-disable-next-line no-console
    console.log(
      `OLP first run — credentials (shown once):\n  username: ${auth.config.username}\n  password: ${auth.plaintextPassword}`,
    );
  }
  setInterval(() => {
    auth.store.prune();
  }, 3600 * 1000).unref();
  telegram.startPoller();
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`OLP listening on http://${host}:${port}`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
