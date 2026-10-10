import { describe, expect, it } from 'vitest';
import { SCROLLBACK_MAX, TerminalManager } from '../src/terminal.js';
import type { TermBackend, TermBackendFactory, TermClient } from '../src/terminal.js';

/** Scriptable fake backend (no real shell). */
class FakeBackend implements TermBackend {
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = 0;
  private outputCb: (chunk: string) => void = () => {};
  private exitCb: () => void = () => {};

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed++;
  }

  onOutput(cb: (chunk: string) => void): void {
    this.outputCb = cb;
  }

  onExit(cb: () => void): void {
    this.exitCb = cb;
  }

  emitOutput(chunk: string): void {
    this.outputCb(chunk);
  }

  emitExit(): void {
    this.exitCb();
  }
}

class FakeClient implements TermClient {
  received: string[] = [];
  open = true;

  send(data: string): void {
    if (!this.open) throw new Error('closed');
    this.received.push(data);
  }

  text(): string {
    return this.received.join('');
  }
}

function setupCounted(opts: { ptyAvailable?: boolean } = {}): {
  manager: TerminalManager;
  backends: FakeBackend[];
  ptyCalls: () => number;
} {
  const backends: FakeBackend[] = [];
  let calls = 0;
  const factory: TermBackendFactory = {
    createPty: () => {
      calls++;
      if (opts.ptyAvailable === false) return null;
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
  const manager = new TerminalManager({ shell: 'sh', cwd: '/root', env: {}, factory });
  return { manager, backends, ptyCalls: () => calls };
}

describe('TerminalManager', () => {
  it('starts with no session', () => {
    const { manager } = setupCounted();
    expect(manager.mode).toBe('none');
    expect(manager.clientCount).toBe(0);
  });

  it('spawns on first attach with fresh banner and pty mode', () => {
    const { manager, backends } = setupCounted();
    const client = new FakeClient();
    manager.attach(client);
    expect(backends.length).toBe(1);
    expect(manager.mode).toBe('pty');
    expect(manager.clientCount).toBe(1);
    expect(client.text()).toMatch(/Terminal ready \(sh, pty\)/);
  });

  it('falls back to pipe when pty is unavailable', () => {
    const { manager } = setupCounted({ ptyAvailable: false });
    const client = new FakeClient();
    manager.attach(client);
    expect(manager.mode).toBe('pipe');
    expect(client.text()).toMatch(/Terminal ready \(sh, pipe\)/);
  });

  it('replays scrollback on reattach without respawning', () => {
    const { manager, backends } = setupCounted();
    const first = new FakeClient();
    manager.attach(first);
    backends[0]?.emitOutput('hello ');
    backends[0]?.emitOutput('world');
    const second = new FakeClient();
    manager.attach(second);
    expect(backends.length).toBe(1);
    expect(manager.clientCount).toBe(2);
    expect(second.text()).toContain('hello world');
    expect(second.text()).toMatch(/Reattached to terminal session/);
  });

  it('fans output out to open clients only', () => {
    const { manager, backends } = setupCounted();
    const live = new FakeClient();
    const dead = new FakeClient();
    dead.open = false;
    manager.attach(live);
    manager.attach(dead);
    backends[0]?.emitOutput('x');
    expect(live.text()).toContain('x');
    expect(dead.text()).not.toContain('x');
  });

  it('dispatches in/rs/raw input', () => {
    const { manager, backends } = setupCounted();
    const client = new FakeClient();
    manager.attach(client);
    const backend = backends[0];
    if (backend === undefined) throw new Error('unreachable');
    manager.handle(client, JSON.stringify({ t: 'in', d: 'ls\n' }));
    manager.handle(client, JSON.stringify({ t: 'in' }));
    manager.handle(client, JSON.stringify({ t: 'rs', c: 100, r: 30 }));
    manager.handle(client, JSON.stringify({ t: 'rs' }));
    manager.handle(client, 'rawkeys');
    expect(backend.written).toEqual(['ls\n', '', 'rawkeys']);
    expect(backend.resizes).toEqual([
      [100, 30],
      [80, 24],
    ]);
  });

  it('respawns on new, migrating clients and killing the old shell', () => {
    const { manager, backends } = setupCounted();
    const a = new FakeClient();
    const b = new FakeClient();
    manager.attach(a);
    manager.attach(b);
    const old = backends[0];
    manager.handle(a, JSON.stringify({ t: 'new' }));
    expect(old?.killed).toBe(1);
    expect(backends.length).toBe(2);
    expect(manager.clientCount).toBe(2);
    expect(a.text()).toMatch(/New terminal session/);
    expect(b.text()).toMatch(/New terminal session/);
    // old backend output no longer reaches anyone
    old?.emitOutput('stale');
    expect(a.text()).not.toContain('stale');
  });

  it('clears the session on shell exit and respawns on next attach', () => {
    const { manager, backends } = setupCounted();
    const client = new FakeClient();
    manager.attach(client);
    backends[0]?.emitExit();
    expect(client.text()).toMatch(/session ended/);
    expect(manager.mode).toBe('none');
    expect(manager.clientCount).toBe(0);
    const next = new FakeClient();
    manager.attach(next);
    expect(backends.length).toBe(2);
    expect(next.text()).toMatch(/Terminal ready/);
  });

  it('detach keeps the shell alive', () => {
    const { manager, backends } = setupCounted();
    const client = new FakeClient();
    manager.attach(client);
    manager.detach(client);
    expect(manager.clientCount).toBe(0);
    expect(backends[0]?.killed).toBe(0);
    expect(backends.length).toBe(1);
    const other = new FakeClient();
    manager.attach(other);
    expect(backends.length).toBe(1);
    expect(other.text()).toMatch(/Reattached/);
  });

  it('trims scrollback to the ring cap', () => {
    const { manager, backends } = setupCounted();
    const client = new FakeClient();
    manager.attach(client);
    backends[0]?.emitOutput('A'.repeat(SCROLLBACK_MAX + 10));
    const late = new FakeClient();
    manager.attach(late);
    const replay = late.received.join('');
    expect(replay.length).toBeLessThanOrEqual(SCROLLBACK_MAX + 100);
    expect(replay).not.toContain('A'.repeat(SCROLLBACK_MAX + 10));
  });

  it('shutdown kills the shell and drops state', () => {
    const { manager, backends } = setupCounted();
    manager.attach(new FakeClient());
    manager.shutdown();
    expect(backends[0]?.killed).toBe(1);
    expect(manager.mode).toBe('none');
    expect(manager.clientCount).toBe(0);
  });
});
