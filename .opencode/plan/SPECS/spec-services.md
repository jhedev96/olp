# SPEC — services

> Module id: `services` (new `packages/services`: init detection, unit
> definitions, per-manager control).
> Owner: TBD. Status: DRAFT.
> Depends on: `env-core` ids (locked). Consumers: installers (Phase 4/5),
> later nginx/cron route migration (follow-up, current direct commands stay).
> Gate: approve before multi-OS service work starts.

## 1. Objective

Give OLP one typed answer to "how does this box supervise daemons":
detect the init system, generate the OLP service definition for it
(systemd unit, OpenRC script, launchd plist, pm2 ecosystem — Termux
parity via the existing `pm2 start/save/resurrect` flow from
`terwo/install.sh:55-91`), and control known services through one
interface, so installers and (later) the nginx/cron routes stop
hardcoding Termux-isms.

Success: `detectInit()` is right on all P0/P1 fixtures; generated units
reference the correct node binary + data dir + localhost bind; control
calls map to the exact native commands; nothing here spawns anything in
tests.

## 2. API Contract (TypeScript)

```ts
// packages/services/src/types.ts
import type { EnvId } from '@olp/env-core';
export type InitSystem = 'systemd' | 'openrc' | 'launchd' | 'pm2' | 'none';
export interface ServiceDef {
  manager: InitSystem;
  /** File content to install (unit/script/plist/ecosystem config). */
  content: string;
  /** Absolute install path, e.g. `/etc/systemd/system/olp.service`. */
  path: string;
  /** Post-install commands in order, e.g. `['systemctl daemon-reload', 'systemctl enable --now olp']`. */
  enable: string[];
}
export interface ServiceController {
  isActive(service: string): Promise<boolean>;
  start(service: string): Promise<void>;   // throws with tail on failure
  stop(service: string): Promise<void>;
}
export interface ServiceInputs {
  nodeBin: string;      // absolute node binary (never bare `node`)
  entry: string;        // absolute server entry (`…/dist/index.js`)
  dataDir: string;      // e.g. `~/.olp`
  host: string; port: number; // bind (default localhost-only posture)
  user: string;         // service user (systemd `User=`, openrc `command_user`)
}
export function detectInit(signals: { platform: string; hasSystemd: boolean; hasOpenrc: boolean; isTermux: boolean }): InitSystem;
export function olpServiceDef(manager: InitSystem, inputs: ServiceInputs): ServiceDef;
export function serviceController(manager: InitSystem, exec: (cmd: string, timeoutMs: number) => Promise<string>): ServiceController;
```

### Behavior

- Detection precedence (pure, fixture-tested): Termux env → `pm2`;
  darwin → `launchd`; `hasSystemd` (`/run/systemd/system` present) →
  `systemd`; `hasOpenrc` (`/sbin/openrc-run` present) → `openrc`; else
  `none` (callers fail with an actionable message, never a guessed
  command).
- `pm2` stays the Termux story verbatim (`install.sh` parity): ecosystem
  content runs `node <entry>` with `PANEL_HOST`/`PANEL_PORT` env, and the
  Termux:Boot resurrection note ships in installer docs (not code).
- systemd unit: `After=network.target`, `Restart=on-failure`,
  `User=<user>`, `Environment=PANEL_HOST/PORT`, `ExecStart=<nodeBin>
  <entry>`; enable = `daemon-reload` + `enable --now olp`.
- OpenRC: `#!/sbin/openrc-run` script with `command`, `command_args`,
  `command_user`, `respawn`; enable = `rc-update add olp default` +
  `rc-service olp start`.
- launchd plist: `Label olp.panel`, `ProgramArguments` node+entry,
  `RunAtLoad`, `KeepAlive`; enable = `bootstrap` + `kickstart` commands
  (documented, best-effort — needs on-device verification, ADR-003).
- Control mapping: systemd `systemctl is-active|start|stop <name>`;
  openrc `rc-service <name> status|start|stop` (status via exit code);
  launchd `launchctl print` probe + `bootout/bootstrap`; pm2
  `pm2 describe|start|stop` (JSON parse for status, best-effort).
  Failures throw tailed messages (last 500 chars, house parity).
- `nodeBin`/`entry` must be absolute (relative entries are a boot-
  flakiness classic — enforced, not suggested).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/services
Test:  npm run test --workspace=@olp/services
```

## 4. Project Structure

```text
packages/services/
  src/types.ts        # InitSystem, ServiceDef, inputs
  src/detect.ts       # detectInit (pure)
  src/units.ts        # olpServiceDef per manager
  src/control.ts      # serviceController per manager
  src/index.ts
  test/services.test.ts
  package.json (name @olp/services, env-core type dep only)
  tsconfig.json
```

## 5. Code Style

```ts
// Good: data + pure functions, exec injected, no spawning in this package.
export function olpServiceDef(manager: InitSystem, inputs: ServiceInputs): ServiceDef { /* ... */ }
```

- JSDoc on all exports (English); absolute paths validated (`path.isAbsolute`).

## 6. Testing Strategy

- Framework: Vitest, zero I/O (all signals/inputs injected).
- Cases: detection matrix (termux/darwin/systemd/openrc/none +
  precedence termux-over-everything); unit content snapshots per manager
  (node/entry/host/port/user present, no bare `node`, localhost default
  preserved); enable-command lists; control command shapes per manager
  via recorded exec (is-active true/false, start/stop, tail-500 on
  failure); relative-path rejection.
- Coverage: all manager branches.

## 7. Boundaries

- Always: absolute paths; localhost bind unless explicitly overridden;
  actionable errors on `none`.
- Ask first: migrating nginx/cron routes onto controllers (follow-up
  task); new managers (runit, s6, Windows services).
- Never: execute anything (generation + mapping only); invent
  launchd/boot semantics without on-device proof (mark best-effort).

## 8. Success Criteria

- [ ] Detection + units + control matrix green with zero I/O.
- [ ] Generated systemd unit boots OLP on a real Debian box (live smoke).
- [ ] Needs on-device verification: Termux pm2 flow, Alpine OpenRC,
  macOS launchd (ADR-003).

## 9. Open Questions

- pm2 for non-Termux too (simpler cross-OS story) vs native managers?
  Proposal: native first (no extra dep), pm2 stays Termux-only.

## 10. Decisions

- `services` generates and maps; it never spawns (installers do).

## 11. Parity mapping (§9.2)

| Terwo (`install.sh`/`panel.js`) | OLP | Mark |
|---|---|---|
| pm2 start/save/resurrect/logs `install.sh:55-91` | pm2 ecosystem + docs same flow | parity |
| `pgrep -x` probes `:1117,:1201` | `isActive` per-manager probes | parity (native commands) |
| detached `crond` spawn `:1208` | controller `start` abstraction | parity (behavior) |
| `pkill -x crond` `:1212` | controller `stop` | parity (native per OS) |
| localhost bind default | units default localhost | parity |
