import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { detect } from '@olp/env-core';
import type { Environment, PkgManId } from '@olp/env-core';
import type { MonitorSampler, SysDeps } from '@olp/sysinfo';
import { createMonitorSampler, samplePid } from '@olp/sysinfo';
import { createAuthContext, registerAuthRoutes, resolveDirs } from './auth.js';
import type { AuthContext } from './auth.js';
import type { PasskeyOps } from './passkey.js';
import { nodeDeps, registerStatsRoutes } from './stats.js';
import { registerMonitorRoutes } from './monitor.js';
import type { KillDeps } from '@olp/sysinfo';
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
import { nodeBackupSys, registerBackupRoutes, startBackupScheduler } from './backup.js';
import type { BackupSystem } from './backup.js';
import { nodeCronBackend, parseCronLine, registerCronRoutes } from './cron.js';
import type { CronJob } from './cron.js';
import type { CronBackend } from './cron.js';
import { registerServicesRoutes } from './services.js';
import type { ServicesControllerOf } from './services.js';
import { realSpawnShell, registerStoreRoutes } from './store.js';
import type { SpawnShell } from './store.js';
import { fileSettingsStore, registerSettingsRoutes } from './settings.js';
import { freshReport, resolveBind } from './settings.js';
import type { BindConfig, BindReport } from './settings.js';
import type { SettingsStore } from './settings.js';
import { migrateLegacy } from './migrate.js';
import { TelegramBot, nodeTelegramApi } from './telegram.js';
import type { BotStatus, TelegramApi } from './telegram.js';
import { createWatchdog, nodeProbe } from './watchdog.js';
import type { WatchdogProbe } from './watchdog.js';
import { registerStaticRoutes, resolveDistDir } from './static.js';
import { getSystemInfo } from '@olp/sysinfo';
import { sessionTokenFromHeader } from '@olp/auth';

/** Server version (single source of truth for health/settings payloads). */
export const SERVER_VERSION = '2.0.0-alpha.1';

/** Configured server plus its auth state (routes mutate `auth`). */
export interface ServerHandle {
  app: FastifyInstance;
  auth: AuthContext;
  env: Environment;
  terminal: TerminalManager;
  telegram: { bot: TelegramBot; startPoller: () => void; stopPoller: () => void };
  watchdog: { checkOnce: () => Promise<void> };
  /** Shared bind report (configured at build, effective after listen). */
  bind: BindReport;
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
  storeExec?: (cmd: string) => Promise<string>;
  storeSpawn?: SpawnShell;
  storeNotify?: (text: string) => void;
  storePrefix?: string;
  storeManager?: PkgManId;
  storeReadSource?: (path: string) => string | null;
  storeDns?: (host: string) => Promise<unknown>;
  settingsStore?: SettingsStore;
  telegramApi?: TelegramApi;
  /** Bot-username thunk override for settings tests (production proxies stored-token getMe). */
  settingsBotUsername?: () => Promise<string | null>;
  /** Restart seam override for settings tests (production exits for a supervisor). */
  settingsRestart?: { exit(code: number): void; supervisor(): string };
  watchdogProbe?: WatchdogProbe;
  /** Kill deps override for monitor tests (production wires `process.*`). */
  monitorKill?: KillDeps;
  /** Sampler override for monitor/sites tests (production shares one). */
  monitorSampler?: MonitorSampler;
  /** Per-pid stats override for sites tests (production samples `/proc`). */
  siteProcStats?: (pid: number) => Promise<{ cpuPercent: number | null; memBytes: number } | null>;
  /** Version-command override for sites tests (production execs with caps). */
  siteRunVersion?: (command: string) => Promise<string | null>;
  /** Controller factory override for services tests. */
  servicesControllerOf?: ServicesControllerOf;
  /** Passkey ceremony override for auth tests (production uses the real lib). */
  passkeyOps?: PasskeyOps;
  /** Web `dist` dir override; `null` forces API-only mode (tests). */
  webDir?: string | null;
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

  const auth = createAuthContext(dataDir, legacyDir, { passkeyOps: opts.passkeyOps });
  migrateLegacy(dataDir, legacyDir);
  registerAuthRoutes(app, auth);
  registerStatsRoutes(app, { env, deps: sysDeps, root });
  // One sampler shared by monitor + sites (single delta timeline).
  const sampler: MonitorSampler = opts.monitorSampler ?? createMonitorSampler();
  registerMonitorRoutes(app, { env, deps: sysDeps, root, kill: opts.monitorKill, sampler });
  registerServicesRoutes(app, { env, deps: sysDeps, controllerOf: opts.servicesControllerOf });
  registerFilesRoutes(app, { root, exec: sysDeps.exec });
  const siteStore = opts.siteStore ?? fileSiteStore(auth.dataDir);
  const siteRuntime = createSiteRuntime();
  registerSitesRoutes(app, {
    root,
    store: siteStore,
    spawner: opts.siteSpawner ?? realSpawner(),
    runtime: siteRuntime,
    procStats: opts.siteProcStats ?? ((pid) => samplePid(sysDeps, sampler, pid)),
    runVersion: opts.siteRunVersion ?? (async (command) => {
      try {
        const first = (await sysDeps.exec(command, 3000)).split('\n')[0]?.trim() ?? '';
        return first === '' ? null : first.slice(0, 80);
      } catch {
        return null;
      }
    }),
  });
  registerProxyRoutes(app, {
    dataDir: auth.dataDir,
    sitesDir: join(auth.dataDir, 'nginx', 'sites'),
    prefix: env.prefix,
    store: opts.proxyStore ?? fileProxyStore(auth.dataDir),
    sys: opts.proxySys ?? nodeProxySys(),
  });
  const dbRegistry = opts.dbRegistry ?? fileRegistry(auth.dataDir);
  const dbDrivers = opts.dbDrivers ?? { mysql: mysqlDriver(), postgres: pgDriver() };
  registerDatabaseRoutes(app, {
    registry: dbRegistry,
    drivers: dbDrivers,
  });
  const bundleDbConfig =
    opts.backupDbConfig ?? ((engine) => normalizeConfig(engine, (dbRegistry.load()[engine] ?? {}) as Record<string, unknown>));
  const cronBackend = opts.cronBackend ?? nodeCronBackend();
  registerBackupRoutes(app, {
    dataDir: auth.dataDir,
    root,
    sys: opts.backupSys ?? nodeBackupSys(),
    dbConfig: bundleDbConfig,
    bundle: {
      listDatabases: async (engine) => {
        try {
          const conn = await dbDrivers[engine].connect(bundleDbConfig(engine));
          try {
            return await dbDrivers[engine].listDatabases(conn);
          } finally {
            await dbDrivers[engine].close(conn).catch(() => '');
          }
        } catch {
          return [];
        }
      },
      readCronJobs: async () => {
        const jobs: CronJob[] = [];
        for (const line of await cronBackend.readLines()) {
          const job = parseCronLine(line);
          if (job !== null) jobs.push(job);
        }
        return jobs;
      },
      readCronLines: () => cronBackend.readLines(),
      writeCronLines: (lines) => cronBackend.writeLines(lines),
    },
  });
  startBackupScheduler({
    sys: opts.backupSys ?? nodeBackupSys(),
    dataDir: auth.dataDir,
    root,
    dbConfig: bundleDbConfig,
    now: () => Date.now(),
  });
  registerCronRoutes(app, { backend: cronBackend, runsPath: join(dataDir, 'cron-runs.json') });
  const settingsStore = opts.settingsStore ?? fileSettingsStore(auth.dataDir);
  // Bind report holder (resolved here so boot and routes share one
  // source of truth; listen mutates effective/fallback in W13-03).
  const bindResolved = resolveBind(process.env, settingsStore.load().bind ?? null);
  const bind = freshReport(bindResolved.bind, bindResolved.source);
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
    bindReport: bind,
    restart: opts.settingsRestart,
    botUsername: opts.settingsBotUsername ?? (async () => {
      const tg = settingsStore.load().telegram;
      if (!tg.enabled || tg.botToken === '') return null;
      try {
        return await telegramApi.getMe(tg.botToken);
      } catch {
        return null;
      }
    }),
  });
  const siteWatcher = (): Array<{ id: string; name: string; port: number; running: boolean }> =>
    siteStore.list().map((site) => ({
      id: site.id,
      name: site.name,
      port: site.port,
      running: siteRuntime.running.has(site.id),
    }));
  const watchdog = createWatchdog({
    sites: siteWatcher,
    probe: opts.watchdogProbe ?? nodeProbe(),
    notify: notifyTelegram,
  });
  registerStoreRoutes(app, {
    env: env.id,
    manager: opts.storeManager ?? env.pkgman,
    home: homedir(),
    prefix: opts.storePrefix,
    check: opts.storeCheck,
    exec: opts.storeExec,
    spawnShell: opts.storeSpawn ?? realSpawnShell,
    readSourceFile: opts.storeReadSource,
    dnsLookup: opts.storeDns,
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
  const webDir = opts.webDir === undefined ? resolveDistDir() : opts.webDir;
  registerStaticRoutes(app, {
    distDir: webDir ?? undefined,
    validate: (header) => auth.store.validate(sessionTokenFromHeader(header)),
  });
  app.setErrorHandler(async (err: Error, _req: FastifyRequest, reply: FastifyReply) => {
    reply.code(400);
    await reply.send({ error: err.message || 'Failed' });
  });
  return { app, auth, env, terminal, telegram: { bot, startPoller, stopPoller }, watchdog, bind };
}

/**
 * Listen with localhost fallback. A taken/forbidden primary bind must
 * never leave a dead panel: log loudly, serve the fallback, and say
 * so in the report. Fallback failing too → throw (nothing to serve).
 */
export async function listenWithFallback(
  app: Pick<FastifyInstance, 'listen'>,
  report: BindReport,
  fallback: BindConfig = { host: '127.0.0.1', port: 8080 },
): Promise<void> {
  try {
    await app.listen({ port: report.configured.port, host: report.configured.host });
    report.effective = { ...report.configured };
    report.fallback = false;
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as Record<string, unknown>)['code'] : undefined;
    if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
    // eslint-disable-next-line no-console
    console.error(
      `Bind ${report.configured.host}:${report.configured.port} failed (${String(code)}) — falling back to ${fallback.host}:${fallback.port}`,
    );
    await app.listen({ port: fallback.port, host: fallback.host });
    report.effective = { ...fallback };
    report.fallback = true;
  }
}

/**
 * Start the server when executed directly (`node dist/index.js`).
 * Bind resolves env > file > localhost-default (single source of
 * truth shared with the settings routes); a bad bind falls back to
 * localhost-only per recovery posture, never a silent death.
 */
async function main(): Promise<void> {
  const { app, auth, telegram, watchdog, bind } = buildServer();
  if (bind.source !== 'env' && (process.env['PANEL_HOST'] !== undefined || process.env['PANEL_PORT'] !== undefined)) {
    // eslint-disable-next-line no-console
    console.error('Ignoring invalid PANEL_HOST/PANEL_PORT, using next bind source');
  }
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
  setInterval(() => {
    watchdog.checkOnce().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.log('Health check failed:', err instanceof Error ? err.message : String(err));
    });
  }, 60000).unref();
  await listenWithFallback(app, bind);
  // eslint-disable-next-line no-console
  console.log(`OLP listening on http://${bind.effective.host}:${bind.effective.port}`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
