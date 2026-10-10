# SPEC — sysinfo

> Module id: `sysinfo`. Owner: TBD. Status: DRAFT.
> Depends on: `env-core` (locked). Gate: approve before porting dashboard stats.

## 1. Objective

Provide typed, per-OS system information (CPU, memory, disk, uptime, battery) behind injectable providers, replacing the inline `os.*` + `exec` + Termux:API logic currently spread across `terwo/panel.js` stats/battery helpers.

Success: `apps/server` dashboard route calls `getSystemInfo(env)` and returns the Terwo-compatible payload; adding a new OS battery backend means adding a parser, not editing the route.

## 2. API Contract (TypeScript)

```ts
// packages/sysinfo/src/types.ts
export interface CpuInfo { load1: number; load5: number; load15: number; cores: number }
export interface MemInfo { total: number; free: number; used: number; percent: number }
export interface DiskInfo { total: number; used: number; free: number; percent: number }
export type BatteryInfo = { percentage: number; status: string } | { error: string };
export interface SystemInfo {
  hostname: string; uptime: number; time: number;
  cpu: CpuInfo; mem: MemInfo; disk: DiskInfo | null; battery: BatteryInfo;
}

export interface SysDeps {
  cpus: () => Array<{ times?: unknown }>; // injectable os.cpus
  totalmem: () => number; freemem: () => number;
  hostname: () => string; uptime: () => number;
  exec: (cmd: string, timeoutMs: number) => Promise<string>; // shell runner
  readDir: (p: string) => string[];      // for /sys/devices/system/cpu fallback
  readFile: (p: string) => string | null; // for /proc/cpuinfo fallback
  now: () => number;
}

export function getSystemInfo(env: Environment, deps: SysDeps, root: string): Promise<SystemInfo>;
export function cpuCores(deps: Pick<SysDeps, 'cpus' | 'readDir' | 'readFile'>): number;
export function getBattery(env: Environment, exec: SysDeps['exec']): Promise<BatteryInfo>;
```

### Behavior

- Payload shape is Terwo-compatible: `hostname/uptime/time/cpu/mem/disk/battery` with the same units (bytes, seconds, 2-decimal loads). Dashboard polling (5s) is unchanged.
- `cpuCores()`: `os.cpus().length`, fallback count of `/sys/devices/system/cpu/cpu[0-9]+`, fallback `processor:` lines in `/proc/cpuinfo`, else `0`. Result may be cached by the caller, never inside `sysinfo` (keep pure).
- `disk`: `df -k <root>` last-line parse (`total/used/avail` in KiB → bytes). Parse failure → `null` (never throw).
- `battery` per env:
  - `termux`: exec absolute `$PREFIX/bin/termux-battery-status` when known else `termux-battery-status`; parse JSON `{percentage, status}`; `command not found` → `{error:'pkg install termux-api'}`; timeout → `{error:'Butuh app Termux:API'}` (legacy message translated to English per PROJECT_RULES: `'Termux:API app required'`).
  - `debian/arch/fedora/rhel` (glibc): try `upower`/`/sys/class/power_supply` — v1 may return `{error:'unavailable'}` with the provider seam in place; full parsers are follow-up tasks.
  - `alpine` (musl): `{error:'unavailable'}` in v1 (documented).
  - `macos`/`windows`/`wsl2`: `{error:'unavailable'}` in v1; stubs reserved for follow-up plans.
- `getSystemInfo()` never throws for provider failures: disk/battery degrade to `null`/`{error}`; only programmer errors (bad `root`) throw.
- Legacy Indonesian battery messages are translated to English at port time (mapping table in the port task).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/sysinfo
Test:  npm run test --workspace=@olp/sysinfo
Lint:  eslint packages/sysinfo --max-warnings=0
```

## 4. Project Structure

```text
packages/sysinfo/
  src/types.ts
  src/cpu.ts
  src/battery.ts
  src/disk.ts
  src/index.ts        # getSystemInfo composer
  test/sysinfo.test.ts
```

## 5. Code Style

```ts
// Good: providers receive deps, never import 'node:os' directly.
export async function getBattery(env: Environment, exec: ExecFn): Promise<BatteryInfo> {
  if (env.id !== 'termux') return { error: 'unavailable' };
  // ...
}
```

- JSDoc on all exports (English). No `any`. No `process.env` reads (env comes from `env-core`).

## 6. Testing Strategy

- Framework: Vitest. All OS interaction injected; no real `exec` or `/proc` in tests.
- Cases: cpu core fallbacks (cpus → sysfs → cpuinfo → 0); disk parse + garbage → null; termux battery JSON ok / not-found / timeout; non-termux → unavailable; composer assembles full payload with fixed `now`.
- Coverage: 100% branches on `cpuCores` fallback chain and battery error mapping.

## 7. Boundaries

- Always: degrade to `null`/`{error}` on provider failure; keep functions pure and injectable.
- Ask first: changing the payload shape (breaks web + telegram consumers); adding a real per-OS battery parser (new exec surface).
- Never: call `detect()` inside `sysinfo` (env is a parameter); shell out except through injected `exec`; cache state module-globally.

## 8. Success Criteria

- [ ] `npm run build --workspace=@olp/sysinfo` green; `vitest run` green.
- [ ] Dashboard route can serve `getSystemInfo()` output with zero `os.*` imports in `apps/server`.
- [ ] No Indonesian strings in new code.

## 9. Open Questions

- Linux battery v1: ship `upower`/`sysfs` parsers now or keep `{error:'unavailable'}` with seam? Proposal: seam now, parsers as follow-up tasks (dashboard already handles `error` display).
- Disk on Windows native: `df` absent — which command? Deferred with Windows-native plan; v1 returns `null`.
```

## 10. Decisions

- None yet.
