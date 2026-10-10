# SPEC — cli

> Module id: `cli` (new top-level workspace `cli/`, package `@olp/cli`,
> binary `olp`).
> Owner: TBD. Status: DRAFT.
> Depends on: `env-core` (prefix/platform signals), `services`
> (detect/units/control), `pkgman` (Node.js install command per env).
> Gate: approve before installer work starts. NOTE: no Terwo counterpart
> exists (Terwo ships only `install.sh`) — this is new surface, so §9.2
> has no parity table; §9.1 evidence is the installer + README flows.

## 1. Objective

Give OLP a single entry point — `olp install|start|stop|restart|status|
logs` — that installs the service definition for the detected init
system and controls it, replacing `install.sh` + README pm2 incantations
with one testable TypeScript CLI. Installers per OS become thin wrappers
(bootstrap Node, `npm ci --omit=dev`, `olp install`).

Success: `olp install --dry-run` prints every file write + command without
touching the system; real runs are injectable and fully unit-tested; no
new privilege model (inherits the pkgman sudo-free follow-up).

## 2. API Contract (TypeScript)

```ts
// cli/src/commands.ts
export type CliCommand = 'install' | 'start' | 'stop' | 'restart' | 'status' | 'logs';
export interface CliEnv {
  platform: string; isTermux: boolean; hasSystemd: boolean; hasOpenrc: boolean;
  prefix: string; home: string; nodeBin: string;
}
export interface CliIo {
  writeFile(path: string, data: string, opts?: { mode?: number }): void;
  exec(cmd: string, timeoutMs: number): Promise<string>;
  log(text: string): void;
}
export interface InstallPlan { manager: InitSystem; writes: Array<{ path: string; bytes: number }>; commands: string[] }
export function planInstall(env: CliEnv, opts: { host: string; port: number; user: string; entry: string; dataDir: string }): InstallPlan;
export function runCommand(cmd: CliCommand, env: CliEnv, io: CliIo, opts?: { host?: string; port?: number; user?: string; entry?: string; dataDir?: string }): Promise<number>; // exit code
```

### Behavior

- `planInstall` is pure: detects the manager, builds inputs (absolute
  `nodeBin`/`entry` enforced by `services`), and returns the file writes
  + enable commands WITHOUT executing (the `--dry-run` surface).
- `install`: writes each file (`0600` units? unit files are conventionally
  `0644` — systemd warns on weird perms; use `0644` for units, `0600`
  stays for secrets which units never contain), runs enable commands in
  order, prints each step. Failures throw with the tail (house parity).
- `start|stop|restart`: via `serviceController(manager)` on the `olp`
  service name (`restart` = stop-then-start, 1 s grace); `none` manager →
  actionable error naming the missing init (never a guessed command).
- `status`: prints `olp: active|inactive (<manager>)`, exit code 0/1.
- `logs`: `journalctl -u olp -n 100 --no-pager` (systemd), `tail
  /var/log/olp.log` best-effort (openrc), `log show --predicate`
  (launchd, best-effort), `pm2 logs olp --lines 100 --nostream` (pm2);
  unknown log locations print where to look instead of failing.
- Argument parsing: minimal hand-rolled parser (no CLI framework dep —
  six commands don't justify one); `--help` + `--dry-run` (install only)
  + `--host/--port/--user/--data-dir/--entry` overrides; unknown command
  → usage + exit 2.
- `runCommand` returns process exit codes (0 ok, 1 runtime failure, 2
  usage); the `bin/olp` entry maps them to `process.exitCode` (testable
  without exiting).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/cli
Test:  npm run test --workspace=@olp/cli
Run:   node cli/dist/cli.js status
```

## 4. Project Structure

```text
cli/
  src/commands.ts   # plan + run (injectable io)
  src/args.ts       # minimal parser (pure, unit-tested)
  src/cli.ts        # bin entry (thin: parse → run → exitCode)
  src/index.ts      # library re-exports (installers reuse planInstall)
  test/cli.test.ts
  package.json (name @olp/cli, bin { olp: dist/cli.js }, services+pkgman deps)
  tsconfig.json
```

## 5. Code Style

```ts
// Good: side effects only through CliIo, plan printable without running.
const plan = planInstall(env, { host: '127.0.0.1', port: 8080, user, entry, dataDir });
for (const w of plan.writes) io.log(`write ${w.path} (${w.bytes} bytes)`);
```

- No `any`; JSDoc on all exports (English); `process.env/exit` only in
  `cli.ts` (library code stays injectable).

## 6. Testing Strategy

- Framework: Vitest, memory `CliIo` (file map + recorded commands +
  printed lines), injected envs per manager.
- Cases: arg parsing matrix (commands, flags, `--help`, unknown →
  exit 2); `planInstall` per manager (paths + enable lists match
  `services` outputs); install writes files + runs enables in order +
  dry-run prints without writing; start/stop/restart/status/logs command
  shapes per manager; `none` manager errors actionable; exit codes.
- Coverage: all command + manager branches.

## 7. Boundaries

- Always: `--dry-run` first in docs; absolute paths; localhost default
  preserved into generated units.
- Ask first: privilege escalation UX (sudo prompt vs run-as-root docs —
  same open question as pkgman); new commands.
- Never: add a CLI framework dep for six commands; write outside
  planned paths; swallow failures (tails included).

## 8. Success Criteria

- [ ] `node cli/dist/cli.js --help` + `--dry-run` install matrix green in tests.
- [ ] Live smoke (Linux): real `install --dry-run` output matches the
  systemd unit from `services` tests; real `status` answers.
- [ ] Installers (follow-up) shell out to the binary, never reimplement.

## 9. Open Questions

- Binary distribution (npm `bin` only vs standalone `pkg`/`caxa` bundle
  vs shell wrappers) — installer-plan decision, not this spec.
- `pm2` for non-Termux (same open question as services spec §9).

## 10. Decisions

- Hand-rolled arg parsing (six commands; framework = over-dependency).
- `0644` for unit files (systemd convention), `0600` stays for secrets.
- No §9.2 table: greenfield surface (evidence: `install.sh` + README
  flows, cited in contract above).
