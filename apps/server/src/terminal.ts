/**
 * Persistent terminal session manager (Terwo parity, typed).
 *
 * Exactly one live shell per manager. Client (re)connects attach to the
 * same shell with scrollback replay; disconnects only detach. The shell
 * backend (pty or pipe) is injected, so unit tests never spawn shells.
 * Real backends live below (`realBackendFactory`); the WS route follows.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import websocketPlugin from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';

/** Max replayable scrollback per session (64 KB, Terwo parity). */
export const SCROLLBACK_MAX = 65536;

/** Wire protocol from the xterm client (JSON) or raw keystrokes. */
export type TermInput =
  | { t: 'in'; d?: unknown }
  | { t: 'rs'; c?: unknown; r?: unknown }
  | { t: 'new' };

/**
 * Shell backend. Implementations must never throw from
 * `write`/`resize`/`kill` (swallow internally, Terwo parity).
 */
export interface TermBackend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onOutput(cb: (chunk: string) => void): void;
  onExit(cb: () => void): void;
}

/** Creates backends; pty returns `null` when unavailable (pipe fallback). */
export interface TermBackendFactory {
  createPty(
    shell: string,
    opts: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): TermBackend | null;
  createPipe(shell: string, opts: { cwd: string; env: NodeJS.ProcessEnv }): TermBackend;
}

/** Minimal socket surface (real WS adapters wrap `ws`). */
export interface TermClient {
  send(data: string): void;
  readonly open: boolean;
}

/** Inputs for {@link TerminalManager} (shell pre-resolved by the server). */
export interface TerminalManagerOptions {
  shell: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  factory: TermBackendFactory;
}

interface Session {
  backend: TermBackend;
  clients: Set<TermClient>;
  scrollback: string;
  mode: 'pty' | 'pipe';
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return (Number.isFinite(n) ? Math.trunc(n) : 0) || fallback;
}

/**
 * Single-session terminal manager. See SPEC `spec-terminal.md`.
 * The manager never reads env or spawns processes directly.
 */
export class TerminalManager {
  private session: Session | null = null;

  constructor(private readonly opts: TerminalManagerOptions) {}

  /** Backend in use (`'none'` when no session exists yet). */
  get mode(): 'pty' | 'pipe' | 'none' {
    return this.session?.mode ?? 'none';
  }

  /** Attached client count (0 without a session). */
  get clientCount(): number {
    return this.session?.clients.size ?? 0;
  }

  /**
   * Attach a client: spawns on first attach (fresh banner),
   * otherwise replays scrollback + reattach banner (no respawn).
   */
  attach(client: TermClient): void {
    const existing = this.session;
    if (existing === null) {
      const sess = this.spawn();
      sess.clients.add(client);
      this.sendTo(client, this.freshBanner(sess.mode));
      return;
    }
    existing.clients.add(client);
    if (existing.scrollback !== '') this.sendTo(client, existing.scrollback);
    this.sendTo(client, '\r\n=== Reattached to terminal session ===\r\n');
  }

  /** Detach a client; the shell keeps running (never kills). */
  detach(client: TermClient): void {
    this.session?.clients.delete(client);
  }

  /**
   * Dispatch client input: `{t:'in'}` writes, `{t:'rs'}` resizes,
   * `{t:'new'}` respawns (migrating all clients), anything else
   * is written raw (legacy clients send bare keystrokes).
   */
  handle(client: TermClient, raw: string): void {
    let sess = this.session;
    if (sess === null) {
      sess = this.spawn();
      sess.clients.add(client);
    } else if (!sess.clients.has(client)) {
      sess.clients.add(client);
    }
    let msg: TermInput | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) msg = parsed as TermInput;
    } catch {
      // raw keystrokes fall through below
    }
    if (msg !== null && msg.t === 'in') {
      this.safeWrite(sess, typeof msg.d === 'string' ? msg.d : '');
    } else if (msg !== null && msg.t === 'rs') {
      this.safeResize(sess, toInt(msg.c, 80), toInt(msg.r, 24));
    } else if (msg !== null && msg.t === 'new') {
      this.respawn(sess);
    } else {
      this.safeWrite(sess, raw);
    }
  }

  /** Kill the shell and drop all state (server shutdown). */
  shutdown(): void {
    const sess = this.session;
    this.session = null;
    if (sess !== null) {
      sess.clients.clear();
      try {
        sess.backend.kill();
      } catch {
        // never throw from lifecycle methods
      }
    }
  }

  private spawn(): Session {
    const { shell, cwd, env, factory } = this.opts;
    const pty = factory.createPty(shell, { cols: 80, rows: 24, cwd, env });
    const sess: Session =
      pty !== null
        ? { backend: pty, clients: new Set(), scrollback: '', mode: 'pty' }
        : { backend: factory.createPipe(shell, { cwd, env }), clients: new Set(), scrollback: '', mode: 'pipe' };
    sess.backend.onOutput((chunk) => this.fanOut(sess, chunk));
    sess.backend.onExit(() => this.onSessionExit(sess));
    this.session = sess;
    return sess;
  }

  private respawn(old: Session): void {
    const clients = [...old.clients];
    try {
      old.backend.kill();
    } catch {
      // ignore kill errors during respawn
    }
    old.clients.clear();
    if (this.session === old) this.session = null;
    const fresh = this.spawn();
    for (const client of clients) fresh.clients.add(client);
    this.broadcast(fresh, this.newBanner(fresh.mode));
  }

  private onSessionExit(sess: Session): void {
    if (this.session !== sess) return;
    this.broadcast(sess, '\r\n=== Terminal session ended (shell exit). Reconnect or send input for a new session. ===\r\n');
    sess.clients.clear();
    this.session = null;
  }

  private fanOut(sess: Session, chunk: string): void {
    if (this.session !== sess) return;
    sess.scrollback += chunk;
    if (sess.scrollback.length > SCROLLBACK_MAX) sess.scrollback = sess.scrollback.slice(-SCROLLBACK_MAX);
    this.broadcast(sess, chunk);
  }

  private broadcast(sess: Session, data: string): void {
    for (const client of sess.clients) this.sendTo(client, data);
  }

  private sendTo(client: TermClient, data: string): void {
    if (!client.open) return;
    try {
      client.send(data);
    } catch {
      // a dead client never breaks the session
    }
  }

  private safeWrite(sess: Session, data: string): void {
    try {
      sess.backend.write(data);
    } catch {
      // backends must not throw, double-guarded
    }
  }

  private safeResize(sess: Session, cols: number, rows: number): void {
    try {
      sess.backend.resize(cols, rows);
    } catch {
      // backends must not throw, double-guarded
    }
  }

  private freshBanner(mode: 'pty' | 'pipe'): string {
    return `\r\n=== Terminal ready (${this.opts.shell}, ${mode}) — persistent session, reload keeps the shell alive ===\r\n`;
  }

  private newBanner(mode: 'pty' | 'pipe'): string {
    return `\r\n=== New terminal session (${this.opts.shell}, ${mode}) ===\r\n`;
  }
}

// ================= Real backends (node-pty optional, pipe fallback) =================

/** Structural shape of a `node-pty` process (no static dep on the package). */
interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  on(event: 'exit', cb: () => void): void;
}

/** Structural shape of the `node-pty` module. */
interface PtyModule {
  spawn(
    shell: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): PtyProcess;
}

/**
 * Load `node-pty` if built, else `null`. The package is optional:
 * absence (or a broken native binding, e.g. unbuilt on Alpine) is
 * a normal fallback to pipe mode, never a crash.
 */
function loadPtyModule(): PtyModule | null {
  try {
    const require = createRequire(import.meta.url);
    return require('node-pty') as PtyModule;
  } catch {
    return null;
  }
}

function wrapPty(proc: PtyProcess): TermBackend {
  let outputCb: (chunk: string) => void = () => {};
  let exitCb: () => void = () => {};
  proc.onData((data) => outputCb(data));
  proc.on('exit', () => exitCb());
  return {
    write: (data) => {
      try {
        proc.write(data);
      } catch {
        // never throw from backend calls
      }
    },
    resize: (cols, rows) => {
      try {
        proc.resize(cols, rows);
      } catch {
        // never throw from backend calls
      }
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        // never throw from backend calls
      }
    },
    onOutput: (cb) => {
      outputCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
  };
}

function wrapPipe(child: ChildProcess): TermBackend {
  let outputCb: (chunk: string) => void = () => {};
  let exitCb: () => void = () => {};
  const emit = (data: unknown): void => {
    outputCb(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  };
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);
  child.on('exit', () => exitCb());
  // A bad shell surfaces as an async error event: convert to a clean exit
  // instead of crashing the process (hardening over Terwo parity).
  child.on('error', () => exitCb());
  return {
    write: (data) => {
      try {
        child.stdin?.write(data);
      } catch {
        // never throw from backend calls
      }
    },
    resize: () => {
      // pipe mode has no dimensions (Terwo parity noop)
    },
    kill: () => {
      try {
        child.kill();
      } catch {
        // never throw from backend calls
      }
    },
    onOutput: (cb) => {
      outputCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
  };
}

/**
 * Production backend factory: `node-pty` when loadable and spawnable,
 * otherwise `child_process` pipes. The pty module is loaded lazily on
 * first use and memoized (a broken binding falls back, never crashes).
 */
export function realBackendFactory(): TermBackendFactory {
  let ptyMod: PtyModule | null | undefined;
  const pty = (): PtyModule | null => {
    if (ptyMod === undefined) ptyMod = loadPtyModule();
    return ptyMod;
  };
  return {
    createPty: (shell, opts) => {
      const mod = pty();
      if (mod === null) return null;
      try {
        return wrapPty(
          mod.spawn(shell, [], {
            name: 'xterm-256color',
            cols: opts.cols,
            rows: opts.rows,
            cwd: opts.cwd,
            env: { ...opts.env, TERM: 'xterm-256color' },
          }),
        );
      } catch {
        return null;
      }
    },
    createPipe: (shell, opts) => {
      const child = spawn(shell, [], {
        cwd: opts.cwd,
        env: { ...opts.env, TERM: 'xterm-256color' },
      });
      return wrapPipe(child);
    },
  };
}

// ================= WebSocket route (/term) =================

/** Minimal socket surface used by the route (real `ws` sockets satisfy it). */
interface WsSocket {
  send(data: string): void;
  close(): void;
  on(event: 'message' | 'close' | 'error', listener: (...args: never[]) => void): void;
}

/** Inputs for {@link registerTerminalRoutes}. */
export interface TermRouteOptions {
  manager: TerminalManager;
  /** Session-cookie check (server passes auth store validation). */
  validate: (cookieHeader: string | undefined) => boolean;
}

/** Normalize WS message payloads to strings (Buffer/ArrayBuffer-safe). */
function messageToString(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) {
    const parts = raw.filter((p): p is Buffer => Buffer.isBuffer(p));
    return Buffer.concat(parts).toString('utf8');
  }
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return String(raw);
}

/**
 * Register `GET /term` (requires `@fastify/websocket`, registered here).
 * Upgrades without a valid session are closed immediately (Terwo parity).
 * The plugin is registered synchronously per `@fastify/websocket` docs;
 * readiness resolves at `listen()`/`inject()` time.
 */
export function registerTerminalRoutes(app: FastifyInstance, opts: TermRouteOptions): void {
  void app.register(websocketPlugin);
  app.get('/term', { websocket: true }, (connection, req) => {
    const socket = ((connection as unknown as { socket?: WsSocket }).socket ??
      connection) as unknown as WsSocket;
    const headers = req.headers as Record<string, string | undefined>;
    if (!opts.validate(headers['cookie'])) {
      try {
        socket.close();
      } catch {
        // ignore close errors on rejected upgrades
      }
      return;
    }
    let alive = true;
    const client: TermClient = {
      send: (data) => {
        socket.send(data);
      },
      get open() {
        return alive;
      },
    };
    opts.manager.attach(client);
    socket.on('message', (raw: unknown) => opts.manager.handle(client, messageToString(raw)));
    const detach = (): void => {
      alive = false;
      opts.manager.detach(client);
    };
    socket.on('close', detach);
    socket.on('error', detach);
  });
}
