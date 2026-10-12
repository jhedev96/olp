# SPEC — monitor wave 1 (read-only telemetry)

> Module ids: `sysinfo` (extend), `server` (new `monitor.ts` routes).
> Owner: TBD. Status: DRAFT (human decisions locked 2026-10-12, see §10).
> Depends on: `env-core` (locked), `spec-sysinfo.md` (conventions).
> Gate: approve before W1-02 (sysinfo code).

## 1. Objective

Serve real monitor telemetry behind two new endpoints so the `/monitor`
page can drop its dummies for everything except process kill: per-core
CPU %, temperature, frequency, model/kernel/arch, swap detail, disk I/O
rates, network interfaces + listening sockets, OS process list, and
best-effort PM2 rows. Kill/restart stay out (deferred wave with authz
design). Dashboard keeps polling the cheap `/api/stats` untouched.

Success: `GET /api/monitor/summary` + `GET /api/monitor/processes`
return documented shapes on Linux with null-degradation per field;
monitor page renders wave/donut/rates/proc-table from them; CAND-001,
CAND-002, CAND-003, CAND-014 close.

## 2. API Contract (TypeScript)

```ts
// packages/sysinfo/src/monitor.ts (new)
export interface CoreStat { index: number; percent: number | null; freqMhz: number | null }
export interface CpuDetail { load1: number; load5: number; load15: number; cores: number; perCore: CoreStat[]; model: string | null; tempC: number | null }
export interface MemDetail extends MemInfo { swapTotal: number | null; swapFree: number | null; buffers: number | null; cached: number | null }
export interface DiskIo { readRateBps: number; writeRateBps: number }
export interface NetIface { name: string; rxBytes: number; txBytes: number; rxRateBps: number | null; txRateBps: number | null }
export interface NetInfo { interfaces: NetIface[]; listeningPorts: number[] } // ports capped at 64, sorted
export interface ProcEntry { pid: number; command: string; cpuPercent: number | null; memBytes: number; uptimeSec: number | null }
export interface Pm2Entry { name: string; pid: number | null; status: string; cpuPercent: number | null; memBytes: number | null }
export interface MonitorSummary {
  hostname: string; uptime: number; time: number; arch: string; kernel: string | null;
  cpu: CpuDetail; mem: MemDetail; disk: (DiskInfo & { io: DiskIo | null }) | null;
  net: NetInfo; battery: BatteryInfo;
}
export interface MonitorSampler { /* opaque previous-snapshot state */ }
export function createMonitorSampler(deps: Pick<SysDeps, 'exec'>): MonitorSampler;
export function sampleSummary(env: Environment, deps: SysDeps, sampler: MonitorSampler, root: string): Promise<MonitorSummary>;
export function sampleProcesses(deps: SysDeps, sampler: MonitorSampler, limit: number): Promise<{ processes: ProcEntry[]; pm2: Pm2Entry[] | null; truncated: boolean }>;

// packages/sysinfo/src/types.ts (additive only)
export interface SysDeps { /* ...existing... */ arch: () => string }

// apps/server/src/monitor.ts (new)
export function registerMonitorRoutes(app: FastifyInstance, opts: { env: Environment; deps: SysDeps; root: string }): void;
// GET /api/monitor/summary -> MonitorSummary
// GET /api/monitor/processes?limit=25 (default 25, max 100) -> { processes, pm2, truncated }
```

### Behavior

- Linux collection (covers Termux/Debian/Alpine — all have `/proc`):
  per-core + system CPU from `/proc/stat` cpu lines; temp from first
  readable `/sys/class/thermal/thermal_zone[0-9]/temp` (millidegree →
  1-decimal °C); freq from `scaling_cur_freq` (kHz → MHz int, null per
  core when absent); model from `/proc/cpuinfo` (`model name`, else
  `Hardware`, else null); kernel from `uname -r` (null on failure);
  swap/buffers/cached from `/proc/meminfo` (kB → bytes, nulls absent);
  disk I/O from `/sys/block/*` (excluding `loop*`, `ram*`, `dm-*`)
  sector deltas × 512; net from `/proc/net/dev` (all ifaces incl `lo`);
  listening ports from `/proc/net/tcp` + `tcp6` state `0A`
  (hex port → dec, deduped, sorted, cap 64); processes from
  `/proc/[0-9]+/stat` (utime+stime) + `status` (VmRSS) + `cmdline`
  (NUL → space, truncate 128 chars, fallback `[comm]`); pid uptime from
  starttime jiffies vs `/proc/stat` btime (Hz resolved once via
  `getconf CLK_TCK`, fallback 100 — documented approximation).
- Deltas (CPU %, net rates, disk rates) come from sampler state owned
  by the route closure (created per `buildServer`, injected — never a
  module global). First poll after boot returns `null` for
  delta-derived fields; the frontend keeps its placeholders.
- PM2 is best-effort: `pm2 jlist` (8 s timeout) parsed to
  `{name, pid, status, cpuPercent, memBytes}`; any failure → `pm2: null`
  (section hidden, never an error).
- Caps: processes top 25 by RSS (truncated flag when more pids seen,
  max 512 pids scanned); command 128 chars; exec timeouts 8 s.
- Auth: routes register behind the session gate like all `/api/*`
  (401 unauthenticated — smoke asserts it).
- `/api/stats` is byte-identical (untouched — dashboard parity safe).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/sysinfo && npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/sysinfo && npm run test --workspace=@olp/server
Smoke: boot throwaway server + node smoke/linux.mjs (expects new monitor checks green)
```

## 4. Project Structure

```text
packages/sysinfo/src/monitor.ts      # sampler + sampleSummary + sampleProcesses
packages/sysinfo/src/types.ts        # + arch() dep (additive)
packages/sysinfo/src/index.ts        # re-export monitor API
packages/sysinfo/test/monitor.test.ts
apps/server/src/monitor.ts           # registerMonitorRoutes
apps/server/test/monitor-routes.test.ts
smoke/linux.mjs                      # + summary/processes/401 checks
apps/web/src/pages/monitor.tsx       # wiring (W1-05, separate task)
```

## 5. Code Style

- Providers take `deps`, never import `node:os` (server `nodeDeps`
  wires `os.arch()`); no `any`; English JSDoc on all exports.
- Parse defensively: every `/proc`/`/sys` read is try/catch → null
  (same doctrine as `cpuCores`/`getDisk`); pure parse helpers exported
  for unit tests (`parseProcStat`, `parseNetDev`, `parseMeminfo`).

## 6. Testing Strategy

- sysinfo: fixture `/proc`/`/sys` strings (multi-core stat, thermal
  present/absent, meminfo partial, net/dev sample, tcp LISTEN rows,
  pid stat/status/cmdline rows); sampler two-poll test (first nulls,
  second deltas); pm2 ok/garbage/absent; 512-pid cap; 128-char command
  truncation.
- server: Fastify `inject()` — shape keys, limit default/max/clamp,
  unauth 401, pm2 null path, stats route untouched (existing suite).
- smoke (behavioral): live boot, login, summary keys + types,
  processes array non-empty + sorted shape, pm2 nullable, 401 without
  cookie, PAGE budget (<2 s on the test box).

## 7. Boundaries

- Always: null-degrade per field; caps enforced; session gate on both routes.
- Ask first: new fields beyond §2 (shape freeze after approval); macOS collection (deferred by decision).
- Never: kill/restart/log-tail/services in this wave; `detect()` inside
  sysinfo; module-global sampler; shell out except via injected `exec`.

## 8. Success Criteria

- [ ] sysinfo + server build green; unit + inject suites green.
- [ ] Smoke monitor checks green on Linux; unauth 401 verified live.
- [ ] Monitor page wired (W1-05); CAND-001/002/003/014 closed.
- [ ] `/api/stats` diff-empty (dashboard regression impossible by construction).

## 9. Open Questions

- macOS collection (`sysctl`, `ps`): deferred wave — needs an
  on-device owner (no macOS in the agent box).
- Hz!=100 platforms: approximation documented; revisit if a counter-
  example appears on-device.

## 10. Decisions (locked 2026-10-12, human)

- Read-only wave first; CAND-004 kill deferred to an authz-designed wave.
- Linux-first with per-field null degradation (Termux/Debian/Alpine via `/proc`).
- New `/api/monitor/*` endpoints; `/api/stats` frozen.
- Full cluster 001+002+003+014 in one wave (014 overlaps the other three).

## 11. Parity mapping (mockup → endpoint)

| Mockup panel | Source after wave | Note |
|---|---|---|
| CPU cluster card (model/kernel/arch) | summary.cpu.model, kernel, arch | wakelock line dropped with record (no queryable source on any OS) |
| Per-core wave + freq | summary.cpu.perCore[] | 3-cluster grouping stays frontend heuristic; values real |
| Temp chip | summary.cpu.tempC | null on VMs (placeholder, honest) |
| Donut + mem | summary.mem | segments stay total-based (per-service needs 015) |
| Disk + rates | summary.disk + io | FS label stays out (no portable source) |
| Net ifaces/sockets | summary.net | rates via frontend ring buffer on cumulative counters |
| Proc table | processes[] | sorted top-25 by RSS; cpu% null on first poll |
| PM2 rows | pm2[] \| null | hidden when pm2 absent |
| Kill Task | — | stays scroll-to-processes until kill wave |
