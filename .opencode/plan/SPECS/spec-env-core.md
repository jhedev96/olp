# SPEC — env-core

> Module id: `env-core`. Owner: TBD. Status: DRAFT.
> Gate: must be approved before any OS-specific port begins (PLAN Phase 2).

## 1. Objective

Provide a single source of truth for environment detection and capabilities so that all feature code (`files`, `sites`, `store`, `services`, `sysinfo`) branches on an `Environment` interface instead of inline `process.platform` / `PREFIX` checks (current tech debt in `terwo/panel.js` shell/PATH/battery handling).

Success: feature code imports only from `@olp/env-core`; adding a new OS means adding a detector case + catalog entries, not editing every route.

## 2. API Contract (TypeScript)

```ts
// packages/env-core/src/types.ts
export type EnvId =
  | 'termux' | 'debian' | 'arch' | 'alpine'
  | 'fedora' | 'rhel' | 'macos' | 'wsl2' | 'windows' | 'unknown';

export type PkgManId =
  | 'pkg' | 'apt' | 'pacman' | 'apk' | 'dnf' | 'yum' | 'brew' | 'winget' | 'none';

export type ServiceManId =
  | 'pm2' | 'systemd' | 'openrc' | 'launchd' | 'wsl-passthrough' | 'windows-sc' | 'none';

export interface Environment {
  id: EnvId;
  prettyName: string;          // e.g. "Debian 12", "Termux", "Alpine 3.20"
  pkgman: PkgManId;
  service: ServiceManId;
  isWsl: boolean;
  prefix: string;              // e.g. Termux $PREFIX or '' elsewhere
  shell: string;               // resolved absolute shell or 'sh' fallback
  pathExtra: string[];         // dirs to append to PATH for exec env
}

export function detect(opts?: { platform?: string; env?: NodeJS.ProcessEnv; readFile?: (p: string) => string }): Environment;
export function execEnv(base: NodeJS.ProcessEnv, e: Environment): NodeJS.ProcessEnv;
```

### Behavior

- `detect()` precedence:
  1. `TERMUX_VERSION` or `PREFIX` containing `com.termux` -> `termux` (pkgman `pkg`, service `pm2`).
  2. `WSL_DISTRO_NAME` or `/proc/version` containing `microsoft` -> `wsl2` (delegate pkgman/service to inner distro detection).
  3. `process.platform === 'darwin'` -> `macos` (`brew`, `launchd`).
  4. `process.platform === 'win32'` -> `windows` (`winget`, `windows-sc` stub).
  5. Linux: parse `/etc/os-release` `ID` + `ID_LIKE`: `debian|ubuntu|linuxmint|pop` -> `debian`; `arch|manjaro|endeavouros` -> `arch`; `alpine` -> `alpine`; `fedora` -> `fedora`; `rhel|centos|rocky|almalinux` -> `rhel`.
  6. Fallback `unknown` (`none`/`none`) — callers must fail closed with actionable message.
- `detect()` never throws on missing `/etc/os-release`; returns `unknown` with reason logged.
- `execEnv()` appends `pathExtra` (Termux `$PREFIX/bin`, `/system/bin` on Android) without duplicating entries; never mutates input.
- `shell` resolution: first existing of `['/bin/bash', '$PREFIX/bin/bash']`, else `'sh'` (preserves legacy fallback semantics).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/env-core
Test:  vitest run packages/env-core
Lint:  eslint packages/env-core --max-warnings=0
```

## 4. Project Structure

```text
packages/env-core/
  src/types.ts
  src/detect.ts
  src/execEnv.ts
  src/index.ts
  test/detect.test.ts        # fixture os-release files per EnvId
  test/fixtures/os-release-{termux,debian,arch,alpine,fedora,rhel,macos,wsl2}.txt
```

## 5. Code Style

```ts
// Good: pure, injectable, testable — no direct fs/os access in detect core.
export function detectFromSignals(signals: Signals): Environment {
  if (signals.termuxPrefix.includes('com.termux')) return termuxEnv(signals);
  // ... rest in precedence order
}
```

- JSDoc on all exported symbols (English).
- No `any`; `unknown` + narrowing for file reads.
- Kebab-case test fixture names matching `EnvId`.

## 6. Testing Strategy

- Framework: Vitest.
- Cases: one fixture per `EnvId` (8+unknown); WSL2 fixture asserts `isWsl=true` plus inner distro id preserved; missing-file case returns `unknown`; `execEnv` dedupe + immutability tests.
- Coverage: 100% branches on `detect()` precedence chain (small pure module — enforceable).

## 7. Boundaries

- Always: fail closed to `unknown` with message naming the missing signal; keep detection synchronous and side-effect free (I/O injected).
- Ask first: adding a new `EnvId` value (touches support matrix + PRD); changing precedence order.
- Never: shell out (`exec`) inside `env-core`; import feature packages (no cycles); read user config.

## 8. Success Criteria

- [ ] `vitest run packages/env-core` green with all fixtures.
- [ ] No `process.platform` / `PREFIX` string checks remain outside `env-core` after Phase 3 (enforced by `grep` in CI).
- [ ] `windows` id exists as stub so the Windows-native follow-up plan needs no interface break.

## 9. Open Questions

- Should `wsl2.id` stay `wsl2` or normalize to inner distro id with `isWsl` flag? Proposal: keep `wsl2` wrapper with `inner: EnvId` field — needs approval.
- Add `musl` vs `glibc` signal for Alpine `node-pty` fallback messaging? Proposal: yes, minimal `libc` field.
- Decisions recorded here with date once resolved.
