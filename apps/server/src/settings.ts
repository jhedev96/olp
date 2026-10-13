import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** Telegram bot configuration (persisted inside settings). */
export interface TelegramSettings {
  botToken: string;
  chatId: string;
  enabled: boolean;
  commandsEnabled: boolean;
}

/** Server settings document (`settings.json`). */
export interface Settings {
  telegram: TelegramSettings;
  /** File bind override (`null` = unset; env keeps precedence — CAND-037). */
  bind: BindFile | null;
}

/** Persisted host/port override (validated at save AND at resolve). */
export interface BindFile {
  host: string;
  port: number;
}

/** Resolved listen address. */
export interface BindConfig {
  host: string;
  port: number;
}

/** Bind report (shared holder: listen mutates effective/fallback). */
export interface BindReport {
  configured: BindConfig;
  source: 'env' | 'file' | 'default';
  effective: BindConfig;
  fallback: boolean;
}

/** Privileged ports stay denied (inventory 1024+ rule). */
const PORT_MIN = 1024;
const PORT_MAX = 65535;

/** Host format (format-only; DNS resolves at listen, failure → fallback). */
const HOST_RE = /^[a-zA-Z0-9.:\[\]-]{1,253}$/;

/** Persisted settings store (`settings.json` in production, memory in tests). */
export interface SettingsStore {
  load(): Settings;
  save(settings: Settings): void;
}

/** Fresh defaults (bot off, commands allowed once enabled, no bind override). */
export function defaultSettings(): Settings {
  return { telegram: { botToken: '', chatId: '', enabled: false, commandsEnabled: true }, bind: null };
}

/** Tolerant bind parse (garbage → `null`, never throws). */
function normalizeBind(raw: unknown): BindFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const checked = validateBind(obj['host'], obj['port']);
  return checked.ok ? checked.bind : null;
}

/**
 * Validate a host/port pair. Host is format-checked only (DNS
 * resolves at listen — failure falls back, never refuses boot);
 * ports under 1024 are denied (privileged + inventory 1024+ rule).
 */
export function validateBind(host: unknown, port: unknown): { ok: true; bind: BindConfig } | { ok: false; error: string } {
  if (typeof host !== 'string' || !HOST_RE.test(host)) {
    return { ok: false, error: 'Host must be 1-253 chars (letters, digits, dots, colons, dashes, brackets)' };
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    return { ok: false, error: `Port must be an integer ${PORT_MIN}-${PORT_MAX} (privileged ports need root)` };
  }
  return { ok: true, bind: { host, port } };
}

/**
 * Resolve the listen address. Precedence (locked): valid env pair
 * wins; else valid file; else localhost default. Invalid values fall
 * through silently here (boot logs the warning) — never crash on a
 * typo. Pure: env + file in, decision out (matrix-tested).
 */
export function resolveBind(
  env: { PANEL_HOST?: string; PANEL_PORT?: string },
  file: BindFile | null,
): { bind: BindConfig; source: 'env' | 'file' | 'default' } {
  const envPort = env.PANEL_PORT === undefined ? NaN : Number.parseInt(env.PANEL_PORT, 10);
  if (env.PANEL_HOST !== undefined && env.PANEL_HOST !== '') {
    const checked = validateBind(env.PANEL_HOST, Number.isNaN(envPort) ? -1 : envPort);
    if (checked.ok) return { bind: checked.bind, source: 'env' };
  } else if (env.PANEL_PORT !== undefined && env.PANEL_PORT !== '') {
    const checked = validateBind('127.0.0.1', Number.isNaN(envPort) ? -1 : envPort);
    if (checked.ok) return { bind: checked.bind, source: 'env' };
  }
  if (file !== null) {
    const checked = validateBind(file.host, file.port);
    if (checked.ok) return { bind: checked.bind, source: 'file' };
  }
  return { bind: { host: '127.0.0.1', port: 8080 }, source: 'default' };
}

/**
 * Coerce a request body to Telegram settings. `commandsEnabled` defaults
 * to `true` when absent (Terwo parity); everything else is string-cast.
 */
export function normalizeTelegram(body: unknown): TelegramSettings {
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const tg = (typeof obj['telegram'] === 'object' && obj['telegram'] !== null
    ? obj['telegram']
    : {}) as Record<string, unknown>;
  return {
    botToken: typeof tg['botToken'] === 'string' ? tg['botToken'] : '',
    chatId: typeof tg['chatId'] === 'string' ? tg['chatId'] : '',
    enabled: tg['enabled'] === true,
    commandsEnabled: tg['commandsEnabled'] === undefined ? true : tg['commandsEnabled'] === true,
  };
}

/** File-backed store in the server data dir (mode `0600`, corrupt → defaults). */
export function fileSettingsStore(dataDir: string): SettingsStore {
  const file = join(dataDir, 'settings.json');
  return {
    load: () => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) return defaultSettings();
        const obj = parsed as Record<string, unknown>;
        return { telegram: normalizeTelegram({ telegram: obj['telegram'] }), bind: normalizeBind(obj['bind']) };
      } catch {
        return defaultSettings();
      }
    },
    save: (settings) => writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 }),
  };
}

/** Inputs for {@link registerSettingsRoutes}. */
export interface SettingsRouteOptions {
  store: SettingsStore;
  /** Live admin username (auth config is mutable). */
  username: () => string;
  version: string;
  /** Restart the telegram poller after config changes (server-owned). */
  onTelegramConfig: () => void;
  /** Deliver the test message (throws with the send error on failure). */
  testSend: (tg: TelegramSettings) => Promise<void>;
  /** Bot username for the verified badge (null = unverified; defaults to a stored-token getMe — tests inject). */
  botUsername?: () => Promise<string | null>;
  /** Shared bind report (listen mutates effective/fallback — W13-03). */
  bindReport: BindReport;
  /** Restart seam (default exits for a supervisor; tests inject fakes). */
  restart?: { exit(code: number): void; supervisor(): string };
}

/** Fresh report (effective == configured until listen proves otherwise). */
export function freshReport(configured: BindConfig, source: BindReport['source']): BindReport {
  return { configured, source, effective: { ...configured }, fallback: false };
}

/** Bind address info (read-only; editing needs a restart-capable config — CAND-037). */
export interface BindInfo {
  host: string;
  port: number;
  loopback: boolean;
}

/** Loopback hosts (UI badge + fallback target). */
export function isLoopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Boot bind source of truth (same keys and defaults as `main()` listen). */
export function currentBind(): BindInfo {
  const host = process.env['PANEL_HOST'] ?? '127.0.0.1';
  const port = Number.parseInt(process.env['PANEL_PORT'] ?? '8080', 10);
  return { host, port: Number.isFinite(port) ? port : 8080, loopback: isLoopbackBind(host) };
}

/**
 * Register settings endpoints (all behind the session gate).
 * The test endpoint answers 400 `{ok:false}` both when unconfigured
 * and when delivery fails (Terwo parity).
 */
export function registerSettingsRoutes(app: FastifyInstance, opts: SettingsRouteOptions): void {
  app.get('/api/settings', async () => ({
    username: opts.username(),
    telegram: opts.store.load().telegram,
    version: opts.version,
    bind: {
      host: opts.bindReport.configured.host,
      port: opts.bindReport.configured.port,
      loopback: isLoopbackBind(opts.bindReport.effective.host),
      source: opts.bindReport.source,
      effectiveHost: opts.bindReport.effective.host,
      effectivePort: opts.bindReport.effective.port,
      fallback: opts.bindReport.fallback,
    },
  }));

  app.post('/api/settings', { bodyLimit: 1024 * 1024 }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const store = opts.store.load();
    store.telegram = normalizeTelegram(body);
    opts.store.save(store);
    try {
      opts.onTelegramConfig();
    } catch {
      // poller restart must not fail the save
    }
    return { ok: true };
  });

  app.post('/api/settings/test-telegram', async (_req, reply) => {
    const tg = opts.store.load().telegram;
    if (!tg.enabled || tg.botToken === '' || tg.chatId === '') {
      reply.code(400);
      return { ok: false as const, error: 'Fill in bot token & chat ID and enable it first' };
    }
    try {
      await opts.testSend(tg);
      return { ok: true as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(400);
      return { ok: false as const, error: message === '' ? 'Failed to send' : message };
    }
  });

  app.get('/api/settings/telegram/identity', async () => {
    // Stored token only (request bodies never supply tokens — a
    // client-supplied token would turn this into an oracle). Silent
    // null on disabled/unset/any failure (no token probing feedback).
    if (opts.botUsername === undefined) return { username: null };
    return { username: await opts.botUsername().catch(() => null) };
  });

  app.post('/api/settings/bind', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const checked = validateBind(body['host'], body['port']);
    if (!checked.ok) {
      reply.code(400);
      return { error: checked.error };
    }
    // Persist only (the listener cannot move without a restart —
    // the response says so, never silent). The shared holder
    // re-resolves so GET stays truthful (effective untouched).
    const store = opts.store.load();
    store.bind = checked.bind;
    opts.store.save(store);
    const resolved = resolveBind(process.env, checked.bind);
    opts.bindReport.configured = resolved.bind;
    opts.bindReport.source = resolved.source;
    return { ok: true, restartRequired: true };
  });

  app.post('/api/server/restart', async () => {
    // Respond FIRST, exit after (setImmediate runs post-flush).
    // Sessions die with the process (in-memory, by design) — the UI
    // polls health, then goes to login. Exit code 0: supervisors
    // restart, manual runners were warned in the dialog copy.
    const restart = opts.restart ?? {
      exit: (code: number) => process.exit(code),
      supervisor: () => (process.env['pm_id'] !== undefined ? 'pm2' : 'unknown'),
    };
    const supervisor = restart.supervisor();
    setImmediate(() => {
      app.close().catch(() => undefined).finally(() => restart.exit(0));
    });
    return { ok: true, supervisor };
  });
}
