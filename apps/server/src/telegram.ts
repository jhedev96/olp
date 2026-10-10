import * as https from 'node:https';
import type { TelegramSettings } from './settings.js';

/** Raw update payload from `getUpdates` (narrowed per field on use). */
export interface TelegramUpdate {
  update_id: number;
  message?: { chat?: { id?: unknown }; text?: unknown };
}

/**
 * Bot API transport. Both calls enforce a 10 s client timeout with hard
 * socket destroy and reject with the API `description` on `ok: false`.
 */
export interface TelegramApi {
  sendMessage(botToken: string, chatId: string, text: string): Promise<void>;
  getUpdates(botToken: string, offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
}

const API_HOST = 'api.telegram.org';
const API_TIMEOUT_MS = 10000;
/** Bot message cap (Terwo parity). */
const TEXT_CAP = 4000;

function postJson(hostname: string, path: string, payload: unknown): Promise<unknown> {
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: API_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as unknown);
          } catch {
            reject(new Error('Invalid Telegram response'));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.on('error', (err) => reject(err));
    const hard = setTimeout(() => {
      req.destroy();
      reject(new Error('Timeout'));
    }, API_TIMEOUT_MS);
    req.on('close', () => clearTimeout(hard));
    req.write(data);
    req.end();
  });
}

function getJson(hostname: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', timeout: API_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as unknown);
        } catch {
          reject(new Error('Invalid response'));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.on('error', (err) => reject(err));
    const hard = setTimeout(() => {
      req.destroy();
      reject(new Error('Timeout'));
    }, API_TIMEOUT_MS);
    req.on('close', () => clearTimeout(hard));
    req.end();
  });
}

function assertOk(parsed: unknown, fallback: string): Record<string, unknown> {
  if (typeof parsed !== 'object' || parsed === null) throw new Error(fallback);
  const obj = parsed as Record<string, unknown>;
  if (obj['ok'] !== true) {
    throw new Error(typeof obj['description'] === 'string' && obj['description'] !== '' ? obj['description'] : fallback);
  }
  return obj;
}

/** Production Bot API client over `node:https`. */
export function nodeTelegramApi(): TelegramApi {
  return {
    sendMessage: async (botToken, chatId, text) => {
      const parsed = await postJson(API_HOST, `/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: String(text).slice(0, TEXT_CAP),
      });
      assertOk(parsed, 'Failed to send');
    },
    getUpdates: async (botToken, offset, timeoutSec) => {
      const parsed = await getJson(API_HOST, `/bot${botToken}/getUpdates?offset=${offset}&timeout=${timeoutSec}`);
      const obj = assertOk(parsed, 'API failed');
      if (!Array.isArray(obj['result'])) throw new Error('Invalid response');
      return obj['result'] as TelegramUpdate[];
    },
  };
}

/** One site row for bot status lines. */
export interface BotStatusSite {
  name: string;
  type: string;
  port: number;
  running: boolean;
}

/** Snapshot the bot formats (assembled by the server, never fetched here). */
export interface BotStatus {
  hostname: string;
  uptime: number;
  cpu: { load1: number; load5: number; load15: number; cores: number };
  mem: { total: number; free: number; used: number; percent: number };
  disk: { percent: number } | null;
  battery: { percentage: number; status: string } | { error: string };
  sites: BotStatusSite[];
}

/** `1h 2j 3m` → English `1d 2h 3m` units (math parity with Terwo `fmtUptime`). */
export function formatUptime(totalSeconds: number): string {
  const sec = Math.floor(totalSeconds);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1048576);
}

/**
 * Answer one bot command from a status snapshot. Pure; unknown commands
 * fall back to the `/help` hint (Terwo `tgReply` parity, English units).
 */
export function botReply(status: BotStatus, command: string): string {
  const running = status.sites.filter((s) => s.running).length;
  switch (command) {
    case '/help':
      return 'Bot commands:\n/status summary\n/ram RAM details\n/cpu CPU details\n/battery battery info\n/sites list websites';
    case '/status': {
      const battery = 'percentage' in status.battery ? `${status.battery.percentage}%` : 'n/a';
      return (
        `🖥 ${status.hostname} | ⏱ ${formatUptime(status.uptime)}\n` +
        `⚙️ CPU load ${status.cpu.load1} (${status.cpu.cores} core)\n` +
        `🧠 RAM ${megabytes(status.mem.used)}/${megabytes(status.mem.total)} MB (${status.mem.percent}%)\n` +
        `💾 Disk ${status.disk !== null ? `${status.disk.percent}%` : 'n/a'} | 🔋 ${battery}\n` +
        `🌐 Website ${running}/${status.sites.length} running`
      );
    }
    case '/ram':
      return (
        `🧠 RAM — Total ${megabytes(status.mem.total)} MB, used ${megabytes(status.mem.used)} MB ` +
        `(${status.mem.percent}%), free ${megabytes(status.mem.free)} MB`
      );
    case '/cpu':
      return (
        `⚙️ CPU (${status.cpu.cores} core) — load ${status.cpu.load1}/${status.cpu.load5}/` +
        `${status.cpu.load15}, uptime ${formatUptime(status.uptime)}`
      );
    case '/battery':
    case '/bat':
      return 'percentage' in status.battery
        ? `🔋 Battery ${status.battery.percentage}% (${status.battery.status})`
        : '🔋 Battery unavailable (needs Termux:API)';
    case '/sites':
      return status.sites.length > 0
        ? `🌐 Website:\n${status.sites.map((s) => `${s.running ? '🟢' : '🔴'} ${s.name} (${s.type}) :${s.port}`).join('\n')}`
        : 'No websites yet';
    default:
      return 'Unknown command. Type /help.';
  }
}

/** Inputs for {@link TelegramBot} (all injected; the class owns no timers). */
export interface BotDeps {
  settings: () => TelegramSettings;
  api: TelegramApi;
  status: () => Promise<BotStatus>;
}

/** Long-poll page size (Terwo `timeout=5` parity). */
const POLL_TIMEOUT_SEC = 5;

/**
 * Command poller core. `pollOnce` fetches one page, advances the offset
 * past every seen update (even on reply failure), and answers allowlisted
 * chats only. Transport/page errors resolve silently — the poller never
 * throws (server logs, Terwo parity).
 */
export class TelegramBot {
  private offset = 0;

  constructor(private readonly deps: BotDeps) {}

  /** Current `getUpdates` offset (advances monotonically). */
  get currentOffset(): number {
    return this.offset;
  }

  /** Fast-forward past history without answering (startup parity). */
  async drain(): Promise<void> {
    const tg = this.deps.settings();
    if (!this.pollingAllowed(tg)) return;
    try {
      const updates = await this.deps.api.getUpdates(tg.botToken, this.offset, 0);
      for (const update of updates) {
        const id = typeof update.update_id === 'number' ? update.update_id : 0;
        this.offset = Math.max(this.offset, id + 1);
      }
    } catch {
      // startup drain failures resolve silently; the next page retries
    }
  }

  async pollOnce(): Promise<void> {
    const tg = this.deps.settings();
    if (!this.pollingAllowed(tg)) return;
    let updates: TelegramUpdate[];
    try {
      updates = await this.deps.api.getUpdates(tg.botToken, this.offset, POLL_TIMEOUT_SEC);
    } catch {
      return;
    }
    for (const update of updates) {
      const id = typeof update.update_id === 'number' ? update.update_id : 0;
      this.offset = Math.max(this.offset, id + 1);
      const message = update.message;
      if (typeof message?.text !== 'string') continue;
      if (String(message.chat?.id) !== String(tg.chatId)) continue;
      const command = (message.text.trim().split(/\s+/)[0] ?? '').split('@')[0]?.toLowerCase() ?? '';
      try {
        const reply = botReply(await this.deps.status(), command);
        await this.deps.api.sendMessage(tg.botToken, tg.chatId, reply);
      } catch {
        // offset already advanced; a failed reply never blocks the page
      }
    }
  }

  private pollingAllowed(tg: TelegramSettings): boolean {
    return tg.enabled && tg.botToken !== '' && tg.chatId !== '' && tg.commandsEnabled !== false;
  }
}
