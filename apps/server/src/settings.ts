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
}

/** Persisted settings store (`settings.json` in production, memory in tests). */
export interface SettingsStore {
  load(): Settings;
  save(settings: Settings): void;
}

/** Fresh defaults (bot off, commands allowed once enabled). */
export function defaultSettings(): Settings {
  return { telegram: { botToken: '', chatId: '', enabled: false, commandsEnabled: true } };
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
        return { telegram: normalizeTelegram({ telegram: obj['telegram'] }) };
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
}

/** Bind address info (read-only; editing needs a restart-capable config — CAND-037). */
export interface BindInfo {
  host: string;
  port: number;
  loopback: boolean;
}

/** Boot bind source of truth (same keys and defaults as `main()` listen). */
export function currentBind(): BindInfo {
  const host = process.env['PANEL_HOST'] ?? '127.0.0.1';
  const port = Number.parseInt(process.env['PANEL_PORT'] ?? '8080', 10);
  return { host, port: Number.isFinite(port) ? port : 8080, loopback: host === '127.0.0.1' || host === 'localhost' || host === '::1' };
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
    bind: currentBind(),
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
}
