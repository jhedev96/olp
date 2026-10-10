import { describe, expect, it } from 'vitest';
import { createWatchdog } from '../src/watchdog.js';
import type { WatchedSite } from '../src/watchdog.js';

function site(overrides: Partial<WatchedSite> = {}): WatchedSite {
  return { id: 'a1', name: 'web', port: 3000, running: true, ...overrides };
}

function rig(sites: WatchedSite[], results: Array<'up' | 'down' | 'throw'>): {
  checkOnce: () => Promise<void>;
  notified: string[];
  downCount: () => number;
  probes: number[];
} {
  const notified: string[] = [];
  const probes: number[] = [];
  let cursor = 0;
  const watchdog = createWatchdog({
    sites: () => sites.map((s) => ({ ...s })),
    probe: {
      check: (port) => {
        probes.push(port);
        const result = results[cursor++] ?? 'up';
        if (result === 'up') return Promise.resolve();
        if (result === 'down') return Promise.reject(new Error('refused'));
        throw new Error('sync probe explosion');
      },
    },
    notify: (text) => {
      notified.push(text);
    },
  });
  return { checkOnce: () => watchdog.checkOnce(), notified, downCount: () => watchdog.downCount, probes };
}

describe('watchdog', () => {
  it('notifies DOWN on first failure only', async () => {
    const { checkOnce, notified } = rig([site()], ['down', 'down']);
    await checkOnce();
    expect(notified).toEqual(['Website "web" DOWN (port 3000)']);
    await checkOnce();
    expect(notified).toHaveLength(1);
  });

  it('notifies recovery once and tracks flapping', async () => {
    const { checkOnce, notified, downCount } = rig([site()], ['down', 'up', 'down']);
    await checkOnce();
    expect(downCount()).toBe(1);
    await checkOnce();
    expect(notified[1]).toBe('Website "web" recovered (port 3000)');
    expect(downCount()).toBe(0);
    await checkOnce();
    expect(notified[2]).toBe('Website "web" DOWN (port 3000)');
  });

  it('stays silent for healthy and stopped sites', async () => {
    const stopped = site({ id: 's2', name: 'old', running: false });
    const { checkOnce, notified, downCount } = rig([site(), stopped], ['up']);
    await checkOnce();
    expect(notified).toHaveLength(0);
    expect(downCount()).toBe(0);
  });

  it('drops stopped sites without notifying', async () => {
    const sites = [site()];
    const { checkOnce, notified } = rig(sites, ['down', 'up']);
    await checkOnce();
    expect(notified).toHaveLength(1);
    sites[0] = site({ running: false });
    await checkOnce();
    expect(notified).toHaveLength(1);
    sites[0] = site({ running: true });
    await checkOnce();
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('DOWN');
  });

  it('never rejects, even on synchronous probe explosions', async () => {
    const { checkOnce, notified } = rig([site()], ['throw', 'up']);
    await expect(checkOnce()).resolves.toBeUndefined();
    expect(notified).toHaveLength(1);
    await expect(checkOnce()).resolves.toBeUndefined();
  });

  it('evaluates each running site independently', async () => {
    const { checkOnce, notified, probes } = rig(
      [site({ id: 'a', name: 'a', port: 3001 }), site({ id: 'b', name: 'b', port: 3002 })],
      ['down', 'up'],
    );
    await checkOnce();
    expect(probes).toEqual([3001, 3002]);
    expect(notified).toEqual(['Website "a" DOWN (port 3001)']);
  });
});
