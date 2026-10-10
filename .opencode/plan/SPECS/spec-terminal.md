# SPEC — terminal

> Module id: `terminal` (part of `@olp/server`, backend abstraction + WS route).
> Owner: TBD. Status: DRAFT.
> Depends on: auth gate (locked), env-core shell resolution (locked).
> Gate: approve before terminal is ported (highest-risk domain: native `node-pty`).

## 1. Objective

Port the Terwo persistent terminal (`terwo/panel.js:1570-1673`: single shared shell over `/term` WebSocket, xterm.js frontend, optional `node-pty` with pipe fallback, 64 KB scrollback for reconnects) to typed Fastify + `@fastify/websocket` handlers backed by an injectable session manager, so reconnects never kill the shell and interactive apps (nano/htop/vim) work when `node-pty` builds.

Success: reload/reconnect attaches to the same shell with scrollback; `{t:'new'}` respawns and migrates clients; pipe mode stays fully usable where `node-pty` fails (Alpine musl, Termux edge cases).

## 2. API Contract (TypeScript)

```ts
// apps/server/src/terminal.ts
export type TermInput = { t: 'in'; d?: unknown } | { t: 'rs'; c?: unknown; r?: unknown } | { t: 'new' };
export interface TermBackend {
  write(data: string): void;            // never throws (swallow like Terwo)
  resize(cols: number, rows: number): void; // noop in pipe mode
  kill(): void;                         // never throws
  onOutput(cb: (chunk: string) => void): void;
  onExit(cb: () => void): void;
}
export interface TermBackendFactory {
  createPty(shell: string, opts: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): TermBackend | null;
  createPipe(shell: string, opts: { cwd: string; env: NodeJS.ProcessEnv }): TermBackend;
}
export interface TermClient { send(data: string): void; readonly open: boolean }
export interface TerminalManagerOptions { shell: string; cwd: string; env: NodeJS.ProcessEnv; factory: TermBackendFactory }
export class TerminalManager {
  constructor(opts: TerminalManagerOptions);
  attach(client: TermClient): void;   // creates session on first attach, replays scrollback otherwise
  detach(client: TermClient): void;   // never kills the shell
  handle(client: TermClient, raw: string): void; // protocol dispatch (in/rs/new/raw)
  readonly mode: 'pty' | 'pipe' | 'none';
  readonly clientCount: number;
  shutdown(): void;
}
export interface TermRouteOptions { manager: TerminalManager; validate: (cookieHeader: string | undefined) => boolean }
export function registerTerminalRoutes(app: FastifyInstance, opts: TermRouteOptions): void; // GET /term { websocket: true }
```

### Behavior

- Transport: `GET /term` via `@fastify/websocket` (new runtime dependency; `node-pty` stays `optionalDependencies` exactly like Terwo `package.json`). Upgrade requests without a valid `tpsid` session are rejected before `handleUpgrade` (Terwo parity: `socket.destroy()` on unauth, `panel.js:1633-1639`).
- Session: exactly one live shell (singleton per manager). First attach spawns; later attaches receive cached scrollback (max 65536 chars, ring-trimmed) plus a reattach banner. Client disconnect only detaches (never kills).
- Backends: prefer pty (`xterm-256color`, 80x24, `cwd: root`, `TERM=xterm-256color`); `createPty` returns `null` when `node-pty` is absent/unbuildable → pipe fallback (stdout+stderr merged to output, stdin write, resize noop). Mode is observable (`manager.mode`) and announced in banners (web UI shows degraded badge in pipe mode).
- Shell resolution (Terwo parity `panel.js:1597`): `process.env.SHELL || env-core shell || 'sh'`. The server passes the resolved shell into the manager (manager never reads env directly).
- Protocol (Terwo parity `panel.js:1650-1667`): JSON `{t:'in', d}` → write `d` (non-string → `''`); `{t:'rs', c, r}` → resize (`| 0 || 80/24` fallback); `{t:'new'}` → kill old session, spawn fresh, migrate all clients, broadcast new-session banner; unparseable input → written raw (legacy `app.js` sends raw keystrokes).
- Exit: on shell exit broadcast the end banner, close all clients, clear the session (next attach spawns fresh). Banner: `Terminal session ended (shell exit). Send {"t":"new"} or reconnect for a new session.` (English; legacy Indonesian translated).
- Banners (English, Terwo-shape preserved): fresh attach announces `shell` + `mode`; reattach announces reconnect; all banners CRLF-framed like Terwo.
- Output fan-out: every chunk appends to scrollback (before trimming) then broadcasts to open clients only; send failures are swallowed per-client (a dead client never breaks the session).
- Errors: backend `write/resize/kill` never throw (try/catch inside, Terwo parity `panel.js:1611-1613`).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
apps/server/src/terminal.ts        # backends, manager, route registration
apps/server/test/terminal.test.ts  # manager unit tests with fake backend + fake clients (no real shell, no network)
```

## 5. Code Style

```ts
// Good: dependencies injected, no node:child_process / node-pty imports in the manager.
const manager = new TerminalManager({ shell: 'sh', cwd: root, env: process.env, factory: realFactory });
```

- `unknown` for all wire input; JSDoc on all exports (English); `node-pty` import isolated in the factory behind `try/require` with a `null` fallback (never top-level-crash when unbuilt).

## 6. Testing Strategy

- Framework: Vitest. Fake `TermBackendFactory` (records writes/resizes, scripted output/exit) + fake `TermClient`s; zero real shells, zero sockets.
- Cases: first attach spawns + fresh banner; second attach gets scrollback + reattach banner (no respawn); input/resize/new dispatch incl. defaults (`c|0||80`); raw-text write-through; `new` migrates clients and broadcasts; exit closes clients + clears session (next attach respawns); detach keeps shell alive; send-throwing client skipped; pipe factory used when pty returns null; scrollback ring-trim at 64 KB.
- Route test (follow-up commit): `@fastify/websocket` inject or live-socket test with temp auth — asserts 401/upgrade-reject without session. Unit suite must pass before route wiring.
- Coverage: all protocol branches + exit/detach paths.

## 7. Boundaries

- Always: auth-gate the upgrade; jail shell `cwd` to file-manager root; never echo passwords/tokens into the session; cap scrollback.
- Ask first: multi-session support (currently singleton by design); changing the wire protocol (breaks `apps/web` xterm client); making `node-pty` mandatory.
- Never: kill the shell on client disconnect; block the event loop on output (fan-out is fire-and-forget per client); import `node-pty` at module top level.

## 8. Success Criteria

- [ ] Manager unit suite green with fake backends; no real shell spawned in tests.
- [ ] Live smoke: xterm `apps/web` connects, runs `echo`, reloads keeping history, `{t:'new'}` respawns, exit banner + reconnect works — in both pty and pipe modes (pipe forced by hiding `node-pty`).
- [ ] No Indonesian strings in new code; no `process.env` reads inside the manager.

## 9. Open Questions

- `@fastify/websocket` version pin (v10 vs v11, Fastify v5 compat) — decided at implementation time with lockfile evidence.
- Binary `node-pty` prebuilds per OS in CI (Alpine musl likely builds from source) — installer docs follow-up.

## 10. Decisions

- None yet.
