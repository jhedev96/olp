import { describe, expect, it, vi } from 'vitest';
import { decideKill } from '../src/kill.js';
import type { KillDeps, KillSignal } from '../src/kill.js';

function deps(overrides: Partial<KillDeps> = {}): KillDeps & { sent: Array<[number, KillSignal]> } {
  const sent: Array<[number, KillSignal]> = [];
  return {
    sent,
    selfPid: () => 100,
    selfUid: () => 1000,
    targetUid: () => 1000,
    sendSignal: (pid, signal) => {
      sent.push([pid, signal]);
    },
    ...overrides,
  };
}

function throws(code: string): KillDeps['sendSignal'] {
  return () => {
    throw Object.assign(new Error(`mock ${code}`), { code });
  };
}

describe('decideKill', () => {
  it('rejects bad pids before touching the sender', () => {
    for (const pid of [0, 1, -3, 1.5, Number.NaN]) {
      const d = deps();
      expect(decideKill(d, pid, 'TERM')).toEqual({ ok: false, reason: pid === 1 ? 'denied-init' : 'bad-pid' });
      expect(d.sent).toEqual([]);
    }
  });

  it('refuses init and self unconditionally (even as root)', () => {
    const root = deps({ selfUid: () => 0 });
    expect(decideKill(root, 1, 'KILL')).toEqual({ ok: false, reason: 'denied-init' });
    expect(decideKill(root, 100, 'KILL')).toEqual({ ok: false, reason: 'denied-self' });
    expect(root.sent).toEqual([]);
  });

  it('enforces owner match for non-root, skips it for root', () => {
    const d = deps();
    expect(decideKill(d, 200, 'TERM')).toEqual({ ok: true, pid: 200, signal: 'TERM' });
    expect(d.sent).toEqual([[200, 'TERM']]);
    expect(decideKill(deps({ targetUid: () => 2000 }), 200, 'TERM')).toEqual({ ok: false, reason: 'denied-owner' });
    expect(decideKill(deps({ targetUid: () => null }), 200, 'TERM')).toEqual({ ok: false, reason: 'denied-owner' });
    const root = deps({ selfUid: () => 0, targetUid: () => 2000 });
    expect(decideKill(root, 200, 'KILL')).toEqual({ ok: true, pid: 200, signal: 'KILL' });
  });

  it('treats unknown panel uid as non-root', () => {
    const d = deps({ selfUid: () => null });
    expect(decideKill(d, 200, 'TERM')).toEqual({ ok: false, reason: 'denied-owner' });
  });

  it('maps sender errno codes', () => {
    expect(decideKill(deps({ sendSignal: throws('ESRCH') }), 200, 'TERM')).toEqual({ ok: false, reason: 'gone' });
    expect(decideKill(deps({ sendSignal: throws('EPERM') }), 200, 'TERM')).toEqual({ ok: false, reason: 'denied-os' });
    expect(decideKill(deps({ sendSignal: throws('EACCES') }), 200, 'TERM')).toEqual({ ok: false, reason: 'denied-os' });
    expect(decideKill(deps({ sendSignal: throws('EOTHER') }), 200, 'TERM')).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'mock EOTHER',
    });
    const spy = vi.fn();
    decideKill(deps({ sendSignal: spy }), 200, 'TERM');
    expect(spy).toHaveBeenCalledWith(200, 'TERM');
  });
});
