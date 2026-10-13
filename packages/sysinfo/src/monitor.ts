import type { Environment } from '@olp/env-core';
import { getBattery } from './battery.js';
import { cpuCores } from './cpu.js';
import { getDisk } from './disk.js';
import type { BatteryInfo, DiskInfo, MemInfo, SysDeps } from './types.js';

/** Per-core CPU state (percent/freq are null when unmeasurable). */
export interface CoreStat {
  index: number;
  percent: number | null;
  freqMhz: number | null;
}

/** Extended CPU detail (loadavg shape preserved for `/api/stats` parity). */
export interface CpuDetail {
  load1: number;
  load5: number;
  load15: number;
  cores: number;
  perCore: CoreStat[];
  model: string | null;
  tempC: number | null;
}

/** Memory detail (base shape preserved; swap/caches null when absent). */
export interface MemDetail extends MemInfo {
  swapTotal: number | null;
  swapFree: number | null;
  buffers: number | null;
  cached: number | null;
}

/** Disk I/O rates in bytes/s (null until a second sample exists). */
export interface DiskIo {
  readRateBps: number;
  writeRateBps: number;
}

/** One network interface (cumulative counters; rates null until delta). */
export interface NetIface {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxRateBps: number | null;
  txRateBps: number | null;
}

/** Network state (listening ports sorted, capped at 64). */
export interface NetInfo {
  interfaces: NetIface[];
  listeningPorts: number[];
}

/** One OS process (cpuPercent null on the first sample after boot). */
export interface ProcEntry {
  pid: number;
  command: string;
  cpuPercent: number | null;
  memBytes: number;
  uptimeSec: number | null;
}

/** One PM2 row (`null` list when pm2 is absent or unparsable). */
export interface Pm2Entry {
  name: string;
  pid: number | null;
  status: string;
  cpuPercent: number | null;
  memBytes: number | null;
}

/** Full monitor summary payload (served by `GET /api/monitor/summary`). */
export interface MonitorSummary {
  hostname: string;
  uptime: number;
  time: number;
  arch: string;
  kernel: string | null;
  cpu: CpuDetail;
  mem: MemDetail;
  disk: (DiskInfo & { io: DiskIo | null }) | null;
  net: NetInfo;
  battery: BatteryInfo;
}

/** Previous-snapshot state for delta metrics (owned by the caller). */
export interface MonitorSampler {
  hz: number | null;
  prevCpu: { idle: number; total: number } | null;
  prevCore: Map<number, { idle: number; total: number }>;
  prevPid: Map<number, { utime: number; stime: number }>;
  prevSysTotal: number | null;
  prevNet: Map<string, { rx: number; tx: number }> | null;
  prevDisk: { read: number; write: number } | null;
  prevAt: number;
}

/** Fresh sampler (deltas resolve to null until the second sample). */
export function createMonitorSampler(): MonitorSampler {
  return { hz: null, prevCpu: null, prevCore: new Map(), prevPid: new Map(), prevSysTotal: null, prevNet: null, prevDisk: null, prevAt: 0 };
}

const MAX_PIDS = 512;
const MAX_CMD = 128;
const MAX_PORTS = 64;

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function num(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Targeted per-pid CPU/RSS sample (shares the sampler delta maps with `sampleProcesses`). */
export interface PidSample {
  cpuPercent: number | null;
  memBytes: number;
}

/**
 * Sample one pid (two file reads, never the 512-pid scan). CPU shares
 * use the same delta timeline as `sampleProcesses` (null on the
 * first poll or when the peer sample is missing); raced exits and
 * unreadable files answer `null` (never throws).
 */
export async function samplePid(
  deps: SysDeps,
  sampler: MonitorSampler,
  pid: number,
): Promise<PidSample | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat: { utime: number; stime: number } | null = null;
  let memBytes = 0;
  try {
    const raw = deps.readFile(`/proc/${pid}/stat`);
    stat = raw === null ? null : parsePidStat(raw);
    const statusRaw = deps.readFile(`/proc/${pid}/status`);
    if (statusRaw !== null) memBytes = parsePidStatus(statusRaw).memBytes;
  } catch {
    return null;
  }
  if (stat === null) return null;
  let sysTotal: number | null = null;
  try {
    const statText = deps.readFile('/proc/stat');
    const aggregate = statText === null ? null : parseCpuLine(statText.split('\n')[0] ?? '');
    sysTotal = aggregate === null ? null : aggregate.total;
  } catch {
    sysTotal = null;
  }
  const prev = sampler.prevPid.get(pid);
  sampler.prevPid.set(pid, { utime: stat.utime, stime: stat.stime });
  const sysDelta = sampler.prevSysTotal !== null && sysTotal !== null ? sysTotal - sampler.prevSysTotal : null;
  if (sysTotal !== null) sampler.prevSysTotal = sysTotal;
  const pidDelta = prev === undefined ? null : stat.utime + stat.stime - (prev.utime + prev.stime);
  const ncpu = Math.max(1, cpuCores(deps));
  return {
    cpuPercent: pidDelta === null || sysDelta === null || sysDelta <= 0 || pidDelta < 0
      ? null
      : Math.round((pidDelta / sysDelta) * ncpu * 100),
    memBytes,
  };
}

/** Parse one `/proc/stat` cpu line into idle/total jiffies. */
export function parseCpuLine(line: string): { idle: number; total: number } | null {
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((f) => !Number.isFinite(f))) return null;
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const total = fields.reduce((sum, f) => sum + f, 0);
  return total > 0 ? { idle, total } : null;
}

/** Percent from two snapshots (null when no delta elapsed). */
export function cpuPercent(prev: { idle: number; total: number }, next: { idle: number; total: number }): number | null {
  const totalDelta = next.total - prev.total;
  if (totalDelta <= 0) return null;
  return Math.round((1 - (next.idle - prev.idle) / totalDelta) * 100);
}

/** First `model name` (else `Hardware`/`model`) from `/proc/cpuinfo`. */
export function parseCpuModel(cpuinfo: string): string | null {
  for (const key of ['model name', 'Hardware', 'model']) {
    const match = cpuinfo.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
    if (match?.[1] !== undefined && match[1].trim() !== '') return match[1].trim();
  }
  return null;
}

/** kB-valued meminfo keys converted to bytes (missing keys → null). */
export function parseMeminfo(meminfo: string): { swapTotal: number | null; swapFree: number | null; buffers: number | null; cached: number | null } {
  const get = (key: string): number | null => {
    const match = meminfo.match(new RegExp(`^${key}:\\s*(\\d+)`, 'm'));
    return match?.[1] === undefined ? null : Number.parseInt(match[1], 10) * 1024;
  };
  return { swapTotal: get('SwapTotal'), swapFree: get('SwapFree'), buffers: get('Buffers'), cached: get('Cached') };
}

/** Parse `/proc/net/dev` (skips the two header lines). */
export function parseNetDev(text: string): Array<{ name: string; rx: number; tx: number }> {
  const out: Array<{ name: string; rx: number; tx: number }> = [];
  for (const line of text.split('\n').slice(2)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const fields = line.slice(colon + 1).trim().split(/\s+/);
    const rx = num(fields[0] ?? '');
    const tx = num(fields[8] ?? '');
    if (name !== '' && rx !== null && tx !== null) out.push({ name, rx, tx });
  }
  return out;
}

/** Listening ports from `/proc/net/tcp` text (state `0A`, hex → dec). */
export function parseTcpListening(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A') continue;
    const portHex = (fields[1] ?? '').split(':')[1] ?? '';
    const port = Number.parseInt(portHex, 16);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** utime/stime/starttime from `/proc/<pid>/stat` (comm may hold spaces). */
export function parsePidStat(text: string): { utime: number; stime: number; starttime: number } | null {
  const rest = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
  const utime = num(rest[11] ?? '');
  const stime = num(rest[12] ?? '');
  const starttime = num(rest[19] ?? '');
  if (utime === null || stime === null || starttime === null) return null;
  return { utime, stime, starttime };
}

/** VmRSS (bytes) + Name from `/proc/<pid>/status`. */
export function parsePidStatus(text: string): { memBytes: number; name: string } {
  const rss = text.match(/^VmRSS:\s*(\d+)/m);
  const name = text.match(/^Name:\s*(.+)$/m);
  return {
    memBytes: rss?.[1] === undefined ? 0 : Number.parseInt(rss[1], 10) * 1024,
    name: name?.[1]?.trim() ?? '',
  };
}

/** btime (boot epoch seconds) from `/proc/stat` text. */
export function parseBtime(stat: string): number | null {
  const match = stat.match(/^btime\s+(\d+)/m);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

async function ensureHz(deps: Pick<SysDeps, 'exec'>, sampler: MonitorSampler): Promise<number> {
  if (sampler.hz !== null) return sampler.hz;
  try {
    const out = await deps.exec('getconf CLK_TCK', 3000);
    const hz = Number.parseInt(out.trim(), 10);
    sampler.hz = Number.isInteger(hz) && hz > 0 ? hz : 100;
  } catch {
    sampler.hz = 100; // Linux is overwhelmingly 100; documented approximation
  }
  return sampler.hz;
}

function rate(prev: number, next: number, seconds: number): number | null {
  if (seconds <= 0 || next < prev) return null;
  return Math.round((next - prev) / seconds);
}

/**
 * Sample the full monitor summary. Every unreadable source degrades to
 * `null` (never throws for provider failures); delta metrics resolve
 * once the sampler has seen two polls.
 */
export async function sampleSummary(
  env: Environment,
  deps: SysDeps,
  sampler: MonitorSampler,
  root: string,
): Promise<MonitorSummary> {
  const loads = deps.loadavg();
  const total = deps.totalmem();
  const free = deps.freemem();
  const used = total - free;
  const nowSec = Math.floor(deps.now() / 1000);
  const elapsed = Math.max(1, nowSec - sampler.prevAt);
  sampler.prevAt = nowSec;

  const [statText, cpuinfo, meminfo, netText, tcp, tcp6, kernel, disk, battery] = await Promise.all([
    Promise.resolve(deps.readFile('/proc/stat')).catch(() => null),
    Promise.resolve(deps.readFile('/proc/cpuinfo')).catch(() => null),
    Promise.resolve(deps.readFile('/proc/meminfo')).catch(() => null),
    Promise.resolve(deps.readFile('/proc/net/dev')).catch(() => null),
    deps.exec('cat /proc/net/tcp', 3000).catch(() => ''),
    deps.exec('cat /proc/net/tcp6', 3000).catch(() => ''),
    deps.exec('uname -r', 3000).then((s) => s.trim() || null, () => null),
    getDisk(deps.exec, root),
    getBattery(env, deps.exec),
  ]);

  // CPU aggregate + per-core (delta or null on first poll).
  let perCore: CoreStat[] = [];
  if (statText !== null) {
    const cores: Array<{ idle: number; total: number }> = [];
    for (const line of statText.split('\n')) {
      const match = line.match(/^cpu(\d+)\s/);
      if (match?.[1] === undefined) continue;
      const parsed = parseCpuLine(line);
      if (parsed !== null) cores[Number.parseInt(match[1], 10)] = parsed;
    }
    const freqs = await Promise.all(
      cores.map(async (_, i) => {
        try {
          const raw = deps.readFile(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
          const khz = raw === null ? null : num(raw.trim());
          return khz === null ? null : Math.round(khz / 1000);
        } catch {
          return null;
        }
      }),
    );
    perCore = cores.map((next, i) => {
      const prev = sampler.prevCore.get(i);
      const percent = prev === undefined ? null : cpuPercent(prev, next);
      sampler.prevCore.set(i, next);
      return { index: i, percent, freqMhz: freqs[i] ?? null };
    });
  }

  // Temperature: first readable thermal zone (millidegree → 1-decimal °C).
  let tempC: number | null = null;
  for (let zone = 0; zone < 8; zone++) {
    try {
      const raw = deps.readFile(`/sys/class/thermal/thermal_zone${zone}/temp`);
      const milli = raw === null ? null : num(raw.trim());
      if (milli !== null) {
        tempC = Math.round((milli / 1000) * 10) / 10;
        break;
      }
    } catch {
      // next zone
    }
  }

  // Disk I/O rates from block-device sector deltas (×512 B).
  let diskIo: DiskIo | null = null;
  try {
    const devices = deps.readDir('/sys/block').filter((d) => !/^(loop|ram|dm-)/.test(d));
    let read = 0;
    let write = 0;
    for (const dev of devices) {
      const raw = deps.readFile(`/sys/block/${dev}/stat`);
      const fields = (raw ?? '').trim().split(/\s+/);
      read += num(fields[2] ?? '') ?? 0;
      write += num(fields[6] ?? '') ?? 0;
    }
    const prev = sampler.prevDisk;
    if (prev !== null) {
      const readRate = rate(prev.read, read, elapsed);
      const writeRate = rate(prev.write, write, elapsed);
      diskIo = readRate === null || writeRate === null ? null : { readRateBps: readRate * 512, writeRateBps: writeRate * 512 };
    }
    sampler.prevDisk = { read, write };
  } catch {
    // io stays null
  }

  // Network cumulative counters + rates.
  const ifaces: NetIface[] = [];
  if (netText !== null) {
    for (const entry of parseNetDev(netText)) {
      const prev = sampler.prevNet?.get(entry.name);
      ifaces.push({
        name: entry.name,
        rxBytes: entry.rx,
        txBytes: entry.tx,
        rxRateBps: prev === undefined ? null : rate(prev.rx, entry.rx, elapsed),
        txRateBps: prev === undefined ? null : rate(prev.tx, entry.tx, elapsed),
      });
    }
    sampler.prevNet = new Map(ifaces.map((i) => [i.name, { rx: i.rxBytes, tx: i.txBytes }]));
  }
  const listeningPorts = [...parseTcpListening(tcp), ...parseTcpListening(tcp6)]
    .filter((p, i, all) => all.indexOf(p) === i)
    .sort((a, b) => a - b)
    .slice(0, MAX_PORTS);

  const memExtra = meminfo === null
    ? { swapTotal: null, swapFree: null, buffers: null, cached: null }
    : parseMeminfo(meminfo);

  return {
    hostname: deps.hostname(),
    uptime: Math.floor(deps.uptime()),
    time: deps.now(),
    arch: deps.arch(),
    kernel: kernel,
    cpu: {
      load1: round2(loads[0] ?? 0),
      load5: round2(loads[1] ?? 0),
      load15: round2(loads[2] ?? 0),
      cores: cpuCores(deps),
      perCore,
      model: cpuinfo === null ? null : parseCpuModel(cpuinfo),
      tempC,
    },
    mem: {
      total,
      free,
      used,
      percent: total > 0 ? Math.round((used / total) * 100) : 0,
      ...memExtra,
    },
    disk: disk === null ? null : { ...disk, io: diskIo },
    net: { interfaces: ifaces, listeningPorts },
    battery,
  };
}

/**
 * Sample the top processes by RSS (default 25, caller clamps the max).
 * cpuPercent resolves from the second sample on; pm2 rows are
 * best-effort (null when pm2 is absent). Never throws for provider
 * failures — an empty list with `truncated: false` is the floor.
 */
export async function sampleProcesses(
  deps: SysDeps,
  sampler: MonitorSampler,
  limit: number,
): Promise<{ processes: ProcEntry[]; pm2: Pm2Entry[] | null; truncated: boolean }> {
  const hz = await ensureHz(deps, sampler);
  const entries: ProcEntry[] = [];
  let scanned = 0;
  // System-wide jiffy total for normalizing per-pid CPU shares.
  let sysTotal: number | null = null;
  try {
    const statText = deps.readFile('/proc/stat');
    const aggregate = statText === null ? null : parseCpuLine(statText.split('\n')[0] ?? '');
    sysTotal = aggregate === null ? null : aggregate.total;
  } catch {
    sysTotal = null;
  }
  try {
    const pids = deps
      .readDir('/proc')
      .filter((d) => /^\d+$/.test(d))
      .slice(0, MAX_PIDS);
    const statText = deps.readFile('/proc/stat');
    const btime = statText === null ? null : parseBtime(statText);
    const nowSec = Math.floor(deps.now() / 1000);
    const ncpu = Math.max(1, cpuCores(deps));
    const sysDelta = sampler.prevSysTotal !== null && sysTotal !== null ? sysTotal - sampler.prevSysTotal : null;
    const nextPid = new Map<number, { utime: number; stime: number }>();
    for (const pidText of pids) {
      const pid = Number.parseInt(pidText, 10);
      scanned++;
      let stat: { utime: number; stime: number; starttime: number } | null = null;
      let status = { memBytes: 0, name: '' };
      let cmdline: string | null = null;
      try {
        const raw = deps.readFile(`/proc/${pid}/stat`);
        stat = raw === null ? null : parsePidStat(raw);
        const statusRaw = deps.readFile(`/proc/${pid}/status`);
        if (statusRaw !== null) status = parsePidStatus(statusRaw);
        cmdline = deps.readFile(`/proc/${pid}/cmdline`);
      } catch {
        continue; // raced exit — skip, never fail the batch
      }
      if (stat === null) continue;
      const prev = sampler.prevPid.get(pid);
      nextPid.set(pid, { utime: stat.utime, stime: stat.stime });
      const command = ((cmdline ?? '').split('\0').filter((p) => p !== '').join(' ') || `[${status.name}]`).slice(0, MAX_CMD);
      const pidDelta = prev === undefined ? null : stat.utime + stat.stime - (prev.utime + prev.stime);
      entries.push({
        pid,
        command,
        cpuPercent: pidDelta === null || sysDelta === null || sysDelta <= 0 || pidDelta < 0
          ? null
          : Math.round((pidDelta / sysDelta) * ncpu * 100),
        memBytes: status.memBytes,
        uptimeSec: btime === null ? null : Math.max(0, nowSec - btime - Math.floor(stat.starttime / hz)),
      });
    }
    sampler.prevPid = nextPid;
    if (sysTotal !== null) sampler.prevSysTotal = sysTotal;
  } catch {
    // floor: whatever parsed so far (possibly empty)
  }

  entries.sort((a, b) => b.memBytes - a.memBytes);
  const capped = Math.max(1, Math.min(limit, 100));
  const truncated = scanned > capped && entries.length > capped;

  let pm2: Pm2Entry[] | null = null;
  try {
    const out = await deps.exec('pm2 jlist', 8000);
    const list = JSON.parse(out) as Array<Record<string, unknown>>;
    if (Array.isArray(list)) {
      pm2 = list.slice(0, 64).map((row) => {
        const env = (row['pm2_env'] ?? {}) as Record<string, unknown>;
        const monit = (row['monit'] ?? {}) as Record<string, unknown>;
        return {
          name: typeof row['name'] === 'string' ? row['name'] : 'unknown',
          pid: typeof env['pid'] === 'number' ? env['pid'] : typeof row['pid'] === 'number' ? row['pid'] : null,
          status: typeof env['status'] === 'string' ? env['status'] : 'unknown',
          cpuPercent: typeof monit['cpu'] === 'number' ? monit['cpu'] : null,
          memBytes: typeof monit['memory'] === 'number' ? monit['memory'] : null,
        };
      });
    }
  } catch {
    pm2 = null; // pm2 absent or unparsable — section hidden
  }

  return { processes: entries.slice(0, capped), pm2, truncated };
}
