import type { Environment } from '@olp/env-core';
import { describe, expect, it } from 'vitest';
import {
  cpuPercent,
  createMonitorSampler,
  parseBtime,
  parseCpuLine,
  parseCpuModel,
  parseMeminfo,
  parseNetDev,
  parsePidStat,
  parsePidStatus,
  parseTcpListening,
  samplePid,
  sampleProcesses,
  sampleSummary,
} from '../src/monitor.js';
import type { SysDeps } from '../src/types.js';

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

const STAT_1 = [
  'cpu  100 0 50 850 0 0 0 0 0 0',
  'cpu0  60 0 30 510 0 0 0 0 0 0',
  'cpu1  40 0 20 340 0 0 0 0 0 0',
  'btime 1728000000',
].join('\n');

// Aggregate + cpu0: +100 jiffies (cpu0 +20 idle → 80% busy). cpu1 frozen.
const STAT_2 = [
  'cpu  120 0 60 920 0 0 0 0 0 0',
  'cpu0  130 0 40 530 0 0 0 0 0 0',
  'cpu1  40 0 20 340 0 0 0 0 0 0',
  'btime 1728000000',
].join('\n');

const CPUINFO = 'processor\t: 0\nmodel name\t: Test CPU 9000 @ 2.84GHz\nprocessor\t: 1\nmodel name\t: Test CPU 9000 @ 2.84GHz\n';
const MEMINFO = [
  'MemTotal:        8000000 kB',
  'MemFree:         2000000 kB',
  'Buffers:          100000 kB',
  'Cached:          1000000 kB',
  'SwapTotal:       2000000 kB',
  'SwapFree:        1800000 kB',
].join('\n');
const NETDEV = [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo frame compressed multicast',
  '    lo: 1000       1    0    0    0     0          0         0     1000       1    0    0    0     0       0          0',
  ' wlan0: 42000000   10    0    0    0     0          0         0   18400000    8    0    0    0     0       0          0',
].join('\n');
const TCP = [
  '  sl  local_address rem_address   st',
  '   0: 0100007F:1F90 00000000:0000 0A',
  '   1: 0100007F:0CEA 00000000:0000 01',
].join('\n');
const PID_STAT = '1234 (my proc) R 1 2 3 4 5 6 7 8 9 10 100 50 0 0 20 0 4 0 5000 100000 500 0 0 0';
const PID_STATUS = 'Name:\tnode\nVmRSS:\t  142000 kB\n';
const BLOCK_STAT = '128 0 2048 100 0 0 4096 200 0 0 0 0 0 0 0';
const PM2 = '[{"name":"api","pid":99,"pm2_env":{"status":"online"},"monit":{"cpu":1.5,"memory":88000000}}]';

function files(first: boolean): Record<string, string | null> {
  return {
    '/proc/stat': first ? STAT_1 : STAT_2,
    '/proc/cpuinfo': CPUINFO,
    '/proc/meminfo': MEMINFO,
    '/proc/net/dev': NETDEV,
    '/sys/class/thermal/thermal_zone0/temp': '38000\n',
    '/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq': '1800000\n',
    '/sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq': null,
    '/sys/block/sda/stat': BLOCK_STAT,
    '/proc/1234/stat': PID_STAT,
    '/proc/1234/status': PID_STATUS,
    '/proc/1234/cmdline': 'node\0server.js\0',
    '/proc/999/stat': '999 (gone) R 0 0 0 0 0 0 0 0 0 0 10 5 0 0 0 0 0 0 1000 0 0 0 0',
  };
}

function fakeExec(first: boolean, pm2: string | null = PM2): SysDeps['exec'] {
  return (cmd: string) => {
    if (cmd.startsWith('cat /proc/net/tcp6')) return Promise.resolve('');
    if (cmd.startsWith('cat /proc/net/tcp')) return Promise.resolve(TCP);
    if (cmd === 'uname -r') return Promise.resolve('6.1.0-test\n');
    if (cmd === 'getconf CLK_TCK') return Promise.resolve('100\n');
    if (cmd === 'pm2 jlist') {
      return pm2 === null ? Promise.reject(new Error('not found')) : Promise.resolve(pm2);
    }
    if (cmd.startsWith('df -k')) {
      return Promise.resolve(
        'Filesystem     1K-blocks    Used Available\n/dev/sda1       131072000 45000000  82000000',
      );
    }
    void first;
    return Promise.reject(new Error(`unexpected exec: ${cmd}`));
  };
}

function deps(first: boolean, nowMs: number, overrides: Partial<SysDeps> = {}): SysDeps {
  const table = files(first);
  return {
    cpus: () => [{}, {}],
    loadavg: () => [0.42, 0.38, 0.29],
    totalmem: () => 8000000 * 1024,
    freemem: () => 2000000 * 1024,
    hostname: () => 'monbox',
    uptime: () => 1209600,
    arch: () => 'x64',
    exec: fakeExec(first),
    readDir: (p: string) => {
      if (p === '/proc') return ['1', 'self', '1234', '999', 'cpuinfo'];
      if (p === '/sys/block') return ['sda', 'loop0'];
      if (p === '/sys/devices/system/cpu') return ['cpu0', 'cpu1'];
      throw new Error(`unexpected dir: ${p}`);
    },
    readFile: (p: string) => table[p] ?? null,
    now: () => nowMs,
    ...overrides,
  };
}

describe('monitor parsers', () => {
  it('parses cpu lines andPercents', () => {
    expect(parseCpuLine('cpu  100 0 50 850 0 0 0 0 0 0')).toEqual({ idle: 850, total: 1000 });
    expect(parseCpuLine('garbage')).toBeNull();
    expect(parseCpuLine('cpu  0 0 0 0')).toBeNull();
    expect(cpuPercent({ idle: 850, total: 1000 }, { idle: 1020, total: 1200 })).toBe(15);
    expect(cpuPercent({ idle: 0, total: 100 }, { idle: 0, total: 100 })).toBeNull();
  });

  it('parses cpu model variants', () => {
    expect(parseCpuModel(CPUINFO)).toBe('Test CPU 9000 @ 2.84GHz');
    expect(parseCpuModel('Hardware\t: BCM2835\n')).toBe('BCM2835');
    expect(parseCpuModel('nothing here\n')).toBeNull();
  });

  it('parses meminfo partially', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      swapTotal: 2000000 * 1024,
      swapFree: 1800000 * 1024,
      buffers: 100000 * 1024,
      cached: 1000000 * 1024,
    });
    expect(parseMeminfo('MemTotal: 1 kB\n')).toMatchObject({ swapTotal: null, buffers: null });
  });

  it('parses net dev and tcp listening', () => {
    expect(parseNetDev(NETDEV)).toEqual([
      { name: 'lo', rx: 1000, tx: 1000 },
      { name: 'wlan0', rx: 42000000, tx: 18400000 },
    ]);
    expect(parseNetDev('junk\n')).toEqual([]);
    expect(parseTcpListening(TCP)).toEqual([8080]);
    expect(parseTcpListening('  sl  local_address rem_address   st\n')).toEqual([]);
  });

  it('parses pid stat with spaced comm and status', () => {
    expect(parsePidStat(PID_STAT)).toEqual({ utime: 100, stime: 50, starttime: 5000 });
    expect(parsePidStat('1 (x) R')).toBeNull();
    expect(parsePidStatus(PID_STATUS)).toEqual({ memBytes: 142000 * 1024, name: 'node' });
    expect(parsePidStatus('Name:\tz\n')).toEqual({ memBytes: 0, name: 'z' });
    expect(parseBtime(STAT_1)).toBe(1728000000);
    expect(parseBtime('nope\n')).toBeNull();
  });
});

describe('sampleSummary', () => {
  it('nulls deltas on the first poll and fills real fields', async () => {
    const sampler = createMonitorSampler();
    const summary = await sampleSummary(debianEnv, deps(true, 1728470400000), sampler, '/root');
    expect(summary.hostname).toBe('monbox');
    expect(summary.arch).toBe('x64');
    expect(summary.kernel).toBe('6.1.0-test');
    expect(summary.cpu.cores).toBe(2);
    expect(summary.cpu.model).toBe('Test CPU 9000 @ 2.84GHz');
    expect(summary.cpu.tempC).toBe(38);
    expect(summary.cpu.perCore).toEqual([
      { index: 0, percent: null, freqMhz: 1800 },
      { index: 1, percent: null, freqMhz: null },
    ]);
    expect(summary.mem.swapTotal).toBe(2000000 * 1024);
    expect(summary.disk?.percent).toBe(34);
    expect(summary.disk?.io).toBeNull();
    expect(summary.net.interfaces[1]).toMatchObject({ name: 'wlan0', rxRateBps: null });
    expect(summary.net.listeningPorts).toEqual([8080]);
    expect(summary.battery).toEqual({ error: 'unavailable' });
  });

  it('computes deltas on the second poll', async () => {
    const sampler = createMonitorSampler();
    await sampleSummary(debianEnv, deps(true, 1728470400000), sampler, '/root');
    const summary = await sampleSummary(debianEnv, deps(false, 1728470401000), sampler, '/root');
    expect(summary.cpu.perCore[0]?.percent).toBe(80);
    expect(summary.cpu.perCore[1]?.percent).toBeNull();
    expect(summary.net.interfaces[1]?.rxRateBps).toBe(0);
    expect(summary.disk?.io).toEqual({ readRateBps: 0, writeRateBps: 0 });
  });

  it('degrades missing sources to null', async () => {
    const sampler = createMonitorSampler();
    const summary = await sampleSummary(
      debianEnv,
      deps(true, 1728470400000, {
        readFile: () => null,
        readDir: () => { throw new Error('no sys'); },
        exec: () => Promise.reject(new Error('no exec')),
      }),
      sampler,
      '/root',
    );
    expect(summary.cpu.model).toBeNull();
    expect(summary.cpu.tempC).toBeNull();
    expect(summary.cpu.perCore).toEqual([]);
    expect(summary.net).toEqual({ interfaces: [], listeningPorts: [] });
    expect(summary.disk).toBeNull();
  });
});

describe('sampleProcesses', () => {
  it('lists top by RSS with null cpu on first poll', async () => {
    const sampler = createMonitorSampler();
    const { processes, pm2, truncated } = await sampleProcesses(deps(true, 1728470400000), sampler, 25);
    expect(processes.map((p) => p.pid)).toEqual([1234, 999]);
    expect(processes[0]).toMatchObject({ command: 'node server.js', cpuPercent: null });
    expect(processes[0]?.memBytes).toBe(142000 * 1024);
    expect(processes[0]?.uptimeSec).toBe(1728470400 - 1728000000 - 50);
    expect(truncated).toBe(false);
    expect(pm2).toEqual([{ name: 'api', pid: 99, status: 'online', cpuPercent: 1.5, memBytes: 88000000 }]);
  });

  it('computes cpu shares on the second poll and clamps limits', async () => {
    const sampler = createMonitorSampler();
    await sampleProcesses(deps(true, 1728470400000), sampler, 25);
    const second = await sampleProcesses(
      deps(false, 1728470401000, {
        readFile: (p: string) => {
          if (p === '/proc/stat') return STAT_2;
          if (p === '/proc/1234/stat') {
            return '1234 (my proc) R 1 2 3 4 5 6 7 8 9 10 140 50 0 0 20 0 4 0 5000 100000 500 0 0 0';
          }
          return files(false)[p] ?? null;
        },
      }),
      sampler,
      500,
    );
    // pid delta 40 jiffies of 100 system jiffies × 2 cores = 80%.
    expect(second.processes[0]?.cpuPercent).toBe(80);
    const one = await sampleProcesses(deps(false, 1728470401000), sampler, 0);
    expect(one.processes).toHaveLength(1);
    expect(one.truncated).toBe(true);
  });

  it('floors failures and nulls pm2', async () => {
    const sampler = createMonitorSampler();
    const broken: SysDeps = deps(true, 0, {
      readDir: () => { throw new Error('no proc'); },
      exec: fakeExec(true, null),
    });
    const { processes, pm2, truncated } = await sampleProcesses(broken, sampler, 25);
    expect(processes).toEqual([]);
    expect(pm2).toBeNull();
    expect(truncated).toBe(false);
  });

  it('truncates long commands', async () => {
    const sampler = createMonitorSampler();
    const long = `1 (x) R 0 0 0 0 0 0 0 0 0 0 1 1 0 0 0 0 0 0 10 0 0 0 0`;
    const { processes } = await sampleProcesses(
      deps(true, 0, {
        readDir: () => ['7'],
        readFile: (p: string) => {
          if (p === '/proc/7/cmdline') return `${'y'.repeat(200)}\0`;
          if (p === '/proc/7/stat') return long.replace('(x)', '(y)');
          if (p === '/proc/7/status') return 'Name:\ty\n';
          if (p === '/proc/stat') return STAT_1;
          return null;
        },
      }),
      sampler,
      25,
    );
    expect(processes[0]?.command.length).toBe(128);
  });
});

describe('samplePid', () => {
  it('samples one pid with null cpu on first poll', async () => {
    const sampler = createMonitorSampler();
    const sample = await samplePid(deps(true, 1728470400000), sampler, 1234);
    expect(sample).toEqual({ cpuPercent: null, memBytes: 142000 * 1024 });
  });

  it('computes shares on the second poll from shared deltas', async () => {
    const sampler = createMonitorSampler();
    await samplePid(deps(true, 1728470400000), sampler, 1234);
    const second = await samplePid(
      deps(false, 1728470401000, {
        readFile: (p: string) => {
          if (p === '/proc/stat') return STAT_2;
          if (p === '/proc/1234/stat') {
            return '1234 (my proc) R 1 2 3 4 5 6 7 8 9 10 140 50 0 0 20 0 4 0 5000 100000 500 0 0 0';
          }
          return files(false)[p] ?? null;
        },
      }),
      sampler,
      1234,
    );
    // pid delta 40 jiffies of 100 system jiffies × 2 cores = 80%.
    expect(second).toEqual({ cpuPercent: 80, memBytes: 142000 * 1024 });
  });

  it('answers null for bad pids and raced exits', async () => {
    const sampler = createMonitorSampler();
    expect(await samplePid(deps(true, 0), sampler, 0)).toBeNull();
    expect(await samplePid(deps(true, 0), sampler, -5)).toBeNull();
    expect(await samplePid(deps(true, 0), sampler, 4242)).toBeNull();
    const throwing: SysDeps = deps(true, 0, { readFile: () => { throw new Error('gone'); } });
    expect(await samplePid(throwing, sampler, 1234)).toBeNull();
  });
});
