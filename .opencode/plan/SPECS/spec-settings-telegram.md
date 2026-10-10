# SPEC — settings + telegram

> Module ids: `settings` + `telegram` (both part of `@olp/server`; the
> Telegram HTTP client is side-effect-free and unit-testable, the poller
> lifecycle is server-owned).
> Owner: TBD. Status: DRAFT.
> Depends on: auth gate (locked), sysinfo + sites registry (locked, feed the
> bot status), store notify seam (locked, wired here).
> Gate: approve before settings/telegram routes land. Completes the backend
> surface (last Terwo domain).

## 1. Objective

Port Terwo settings + Telegram (`terwo/panel.js:715-864`: `settings.json`
store, Bot API send/getUpdates over `node:https`, 10 s command polling with
offset drainage, six bot commands, finish/down/recover notifications) to
typed Fastify handlers plus an injectable bot core, so notifications and
bot commands work identically with zero network in tests.

Success: settings round-trip with `0600` persistence; test-message flow;
bot answers all six commands from an injected status snapshot; poller
ignores foreign chats and resumes offsets; install-finish notifications
flow through the store seam.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/settings.ts
export interface TelegramSettings { botToken: string; chatId: string; enabled: boolean; commandsEnabled: boolean }
export interface Settings { telegram: TelegramSettings }
export interface SettingsStore { load(): Settings; save(settings: Settings): void }
export function defaultSettings(): Settings;
export function normalizeTelegram(body: Record<string, unknown>): TelegramSettings;
export function registerSettingsRoutes(app: FastifyInstance, opts: { store: SettingsStore; username: () => string; version: string; onTelegramConfig: () => void; testSend: (tg: TelegramSettings) => Promise<void> }): void;
// GET /api/settings → {username, telegram, version}
// POST /api/settings {telegram} → {ok:true} (persists, restarts poller via onTelegramConfig)
// POST /api/settings/test-telegram → {ok:true} | 400 {ok:false, error}

// apps/server/src/telegram.ts
export interface TelegramApi {
  sendMessage(botToken: string, chatId: string, text: string): Promise<void>; // 4k cap, 10 s timeout, parses ok/description
  getUpdates(botToken: string, offset: number, timeoutSec: number): Promise<Array<{ update_id: number; message?: { chat?: { id: unknown }; text?: unknown } }>>;
}
export interface BotStatusSite { name: string; type: string; port: number; running: boolean }
export interface BotStatus { hostname: string; uptime: number; cpu: { load1: number; load5: number; load15: number; cores: number }; mem: { total: number; free: number; used: number; percent: number }; disk: { percent: number } | null; battery: { percentage: number; status: string } | { error: string }; sites: BotStatusSite[] }
export function botReply(status: BotStatus, command: string): string; // pure: /help/status/ram/cpu/battery|bat/sites + unknown fallback
export interface BotDeps { settings: () => TelegramSettings; api: TelegramApi; status: () => Promise<BotStatus> }
export class TelegramBot {
  constructor(deps: BotDeps);
  pollOnce(): Promise<void>;   // one getUpdates page: offset advance, allowlisted dispatch, send replies
  drain(): Promise<void>;      // offset fast-forward (startup, Terwo timeout=0 parity)
  readonly offset: number;
}
export function nodeTelegramApi(): TelegramApi; // node:https production client
export function formatUptime(sec: number): string;
export function notify/storage wiring: server passes `(text) => void` into store routes + watchdog (watchdog: separate spec)
```

### Endpoints (all behind the session gate)

| Method + path | Body | Rules | Success |
|---|---|---|---|
| `GET /api/settings` | — | — | `{username, telegram, version}` (stored over defaults) |
| `POST /api/settings` | `{telegram}` | 1 MB JSON; normalize + persist `0600`; restart poller | `{ok:true}` |
| `POST /api/settings/test-telegram` | — | 400 `{ok:false, error:'Fill in bot token & chat ID and enable it first'}` when disabled/incomplete | `{ok:true}` or 400 `{ok:false, error}` |

### Behavior

- Settings file `settings.json` in the data dir, mode `0600`; missing/corrupt → defaults (never throws on load).
- Normalize (Terwo parity): strings coerced, `enabled` boolean-cast, `commandsEnabled` defaults `true` when absent.
- Poller runs only when `enabled && botToken && chatId && commandsEnabled !== false` (checked on every page + at (re)start, Terwo parity).
- `drain()` calls `getUpdates(offset 0-ish, timeout 0)` and fast-forwards past history so restarts never replay old commands.
- `pollOnce()`: `getUpdates(offset, timeout 5)`; offset advances past every seen `update_id` even on reply failure; non-text messages skipped; foreign `chat.id` ignored (string-compared, Terwo parity); command = first whitespace token, `@bot` suffix stripped, lowercased; reply sent per command; API/page errors resolve silently (logged by server, never thrown — poller never crashes).
- Replies (English; Terwo shape preserved): `/help` identical command list; `/status` hostname/uptime/load/cores/RAM/disk/battery/websites line; `/ram`, `/cpu`, `/battery|/bat`, `/sites` (🟢/🔴 per site or `No websites yet`); unknown → `Unknown command. Type /help.`
- Battery presence checks `'percentage' in battery` (bugfix deviation: Terwo tested truthiness on an always-object, printing `undefined%` on errors).
- Uptime units English (`2d 3h 15m`; Terwo `h/j/m` Indonesian initials — deviation recorded).
- Test message rebranded: `OLP notification test successful!` (rebrand deviation).
- Install-finish notifications wire the existing store `notify` seam: server passes a sender built from live settings (`enabled+token+chat` checked per send, fire-and-forget with console log on failure — Terwo `sendTelegram` parity).
- Text cap 4000 chars; HTTP timeout 10 s with hard destroy; non-`ok` API answers reject with `description`; unparseable answers reject `Invalid Telegram response`/`Invalid response` respectively (Terwo verbatim).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
apps/server/src/settings.ts
apps/server/src/telegram.ts
apps/server/test/settings-telegram.test.ts  # inject() + fake store/api/status (no network)
```

## 5. Code Style

```ts
// Good: network injectable, timers server-owned, no polling inside the bot class.
const bot = new TelegramBot({ settings: () => loadLiveSettings(), api: nodeTelegramApi(), status: snapshot });
setInterval(() => { bot.pollOnce().catch((e) => console.log('Telegram poll:', (e as Error).message)); }, 10000).unref();
```

- `unknown` wire input narrowed per field; JSDoc on all exports (English); `node:https` only inside `nodeTelegramApi`.

## 6. Testing Strategy

- Framework: Vitest, Fastify `inject()` for routes + direct `TelegramBot` unit tests with scripted `getUpdates` pages.
- Cases: settings get defaults/merge/version/username; save normalizes (missing `commandsEnabled` → true) + persists + restarts poller (spy); test-message disabled → 400 shape, send failure → 400 `{ok:false}`, success → ok; bot reply matrix (all six + unknown + `/bat` alias + `@BotName` suffix + extra args ignored); foreign chat ignored + offset still advances; non-text skipped; reply-send failure doesn't block offset; disabled poller short-circuits without API calls; drain fast-forwards; notifier text exact (`✅/❌ Install …`); gate 401 on one route.
- Coverage: all command + guard branches.

## 7. Boundaries

- Always: chat allowlist before any reply; `0600` settings; never log tokens (settings GET returns them to the authed admin UI — Terwo parity, documented: admin-only route).
- Ask first: webhook mode (currently polling only); multi-chat support; redacting tokens from settings GET.
- Never: reply to foreign chats; throw from the poll loop; block shutdown on the poll timer (unrefed, stopped on config change).

## 8. Success Criteria

- [ ] All behaviors per table with zero network in tests.
- [ ] Live smoke (optional, manual): real bot token answers `/status` on demand; test-message arrives. (Requires a human token — never in CI.)
- [ ] Backend surface complete: every Terwo `/api/*` + `/term` route has an OLP counterpart (audit checklist in TODOS).

## 9. Open Questions

- Watchdog (site down/recover notifications, `panel.js:1391-1406`) — separate `spec-watchdog.md` after this lands (needs sites registry + notifier, both ready).
- `username` in settings GET reads live auth config (server passes getter — done in contract).

## 10. Decisions

- Polling stays (no webhooks) for v2.0 — NAT-friendly like Termux, no inbound port needed.

## 11. Parity mapping (§9.2)

| Terwo (`panel.js:line`) | OLP | Mark |
|---|---|---|
| `loadSettings/saveSettings` `:717-723` (defaults, `0600`) | settings store same | parity |
| `telegramSend` `:724` (4k cap, 10 s, ok/description) | `sendMessage` same | parity |
| `sendTelegram` `:749` (guards, fire-and-forget log) | notifier sender same | parity |
| `apiSettingsGet/Post` `:756-769` (+ poller restart) | settings routes same | parity |
| `apiTelegramTest` `:770` (400 shape, test text) | test route same (text rebranded) | deviation (rebrand) |
| `tgApiGet` `:782` | `getUpdates` same | parity |
| `fmtUptime/mb` `:802-809` | same math, English units | deviation (§9.3) |
| `tgReply` `:810` (six commands) | `botReply` same shapes | parity |
| battery truthiness `:817,829` | `'percentage' in` check | deviation (bugfix) |
| `tgPollOnce` `:835` (offset, allowlist, silent errors) | `pollOnce` same | parity |
| start/stop poll `:853-864` (drain + 10 s) | server lifecycle same | parity |
| install notify `:496`, watchdog `:1396-1401` | store seam + watchdog spec | parity (wiring) |
| Routes `:1527-1529` | same paths/methods | parity |
