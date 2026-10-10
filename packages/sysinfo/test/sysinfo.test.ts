import type { Environment } from '@olp/env-core';
import { describe, expect, it } from 'vitest';
import { getBattery } from '../src/battery.js';
import { cpuCores } from '../src/cpu.js';
import { getDisk, parseDf } from '../src/disk.js';
import { getSystemInfo } from '../src/index.js';
import type { SysDeps } from '../src/types.js';

const termuxEnv: Environment = {
  id: 'termux',
  prettyName: 'Termux',
  pkgman: 'pkg',
  service: 'pm2',
  isWsl: false,
  prefix: '/data/data/com.termux/files/usr',
  shell: 'sh',
  pathExtra: [],
};

const debianEnv: Environment = {
  id: 'debian',
  prettyName: 'Debian 12',
  pkgman: 'apt',
  service: 'systemd',
  isWsl: false,
  libc: 'glibc',
  prefix: '',
  shell: 'sh',
  pathExtra: [],
};

function baseDeps(overrides: Partial<SysDeps> = {}): SysDeps {
  return {
    cpus: () => [{}, {}, {}, {}],
    loadavg: () => [1.234, 0.567, 0.123],
    totalmem: () => 8 * 1024 * 1024 * 1024,
    freemem: () => 2 * 1024 * 1024 * 1024,
    hostname: () => 'olp-test',
    uptime: () => 3661.7,
    exec: () => Promise.reject(new Error('not stubbed')),
    readDir: () => [],
    readFile: () => null,
    now: () => 1728470400000,
    ...overrides,
  };
}

describe('cpuCores', () => {
  it('uses os.cpus() when available', () => {
    expect(cpuCores(baseDeps({ cpus: () => [{}, {}] }))).toBe(2);
  });

  it('falls back to sysfs entries', () => {
    const deps = baseDeps({
      cpus: () => [],
      readDir: () => ['cpu0', 'cpu1', 'cpufreq', 'cpu2'],
    });
    expect(cpuCores(deps)).toBe(3);
  });

  it('falls back to /proc/cpuinfo', () => {
    const deps = baseDeps({
      cpus: () => {
        throw new Error('nope');
      },
      readDir: () => {
        throw new Error('nope');
      },
      readFile: () => 'processor\t: 0\nprocessor\t: 1\n',
    });
    expect(cpuCores(deps)).toBe(2);
  });

  it('returns 0 when undetectable', () => {
    const deps = baseDeps({
      cpus: () => [],
      readDir: () => [],
      readFile: () => null,
    });
    expect(cpuCores(deps)).toBe(0);
  });
});

describe('parseDf / getDisk', () => {
  it('parses df output to bytes', () => {
    const out = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 1000 250 750 25% /\n';
    expect(parseDf(out)).toEqual({ total: 1000 * 1024, used: 250 * 1024, free: 750 * 1024, percent: 25 });
  });

  it('returns null on garbage', () => {
    expect(parseDf('garbage\n')).toBeNull();
    expect(parseDf('')).toBeNull();
    expect(parseDf('a b\n')).toBeNull();
  });

  it('returns null when exec fails', async () => {
    await expect(getDisk(() => Promise.reject(new Error('df failed')), '/')).resolves.toBeNull();
  });
});

describe('getBattery', () => {
  it('parses termux JSON', async () => {
    const exec = () => Promise.resolve('{"percentage": 87, "status": "CHARGING"}');
    await expect(getBattery(termuxEnv, exec)).resolves.toEqual({ percentage: 87, status: 'CHARGING' });
  });

  it('defaults empty status', async () => {
    const exec = () => Promise.resolve('{"percentage": 50}');
    await expect(getBattery(termuxEnv, exec)).resolves.toEqual({ percentage: 50, status: '' });
  });

  it('maps command-not-found to install hint', async () => {
    const exec = () => Promise.reject(new Error("command not found: termux-battery-status"));
    await expect(getBattery(termuxEnv, exec)).resolves.toEqual({ error: 'pkg install termux-api' });
  });

  it('maps timeout to app hint', async () => {
    const exec = () => Promise.reject(new Error('command timed out'));
    await expect(getBattery(termuxEnv, exec)).resolves.toEqual({ error: 'Termux:API app required' });
  });

  it('maps bad JSON to no-response', async () => {
    const exec = () => Promise.resolve('not json');
    await expect(getBattery(termuxEnv, exec)).resolves.toEqual({ error: 'Termux:API no response' });
  });

  it('returns unavailable off Termux', async () => {
    const exec = () => Promise.resolve('{}');
    await expect(getBattery(debianEnv, exec)).resolves.toEqual({ error: 'unavailable' });
  });
});

describe('getSystemInfo', () => {
  it('assembles the Terwo-compatible payload', async () => {
    const deps = baseDeps({
      exec: (cmd) => {
        if (cmd.startsWith('df')) {
          return Promise.resolve('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 2000 500 1500 25% /\n');
        }
        return Promise.resolve('{"percentage": 99, "status": "FULL"}');
      },
    });
    const info = await getSystemInfo(termuxEnv, deps, '/home/test');
    expect(info.hostname).toBe('olp-test');
    expect(info.uptime).toBe(3661);
    expect(info.time).toBe(1728470400000);
    expect(info.cpu).toEqual({ load1: 1.23, load5: 0.57, load15: 0.12, cores: 4 });
    expect(info.mem).toEqual({
      total: 8 * 1024 * 1024 * 1024,
      free: 2 * 1024 * 1024 * 1024,
      used: 6 * 1024 * 1024 * 1024,
      percent: 75,
    });
    expect(info.disk?.percent).toBe(25);
    expect(info.battery).toEqual({ percentage: 99, status: 'FULL' });
  });

  it('degrades disk and battery without throwing', async () => {
    const deps = baseDeps({ exec: () => Promise.reject(new Error('boom')) });
    const info = await getSystemInfo(debianEnv, deps, '/');
    expect(info.disk).toBeNull();
    expect(info.battery).toEqual({ error: 'unavailable' });
  });
});
