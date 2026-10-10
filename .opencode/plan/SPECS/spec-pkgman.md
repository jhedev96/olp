# SPEC — pkgman + store

> Module ids: `pkgman` (new `packages/pkgman`: pure per-OS catalog) and
> `store` (part of `@olp/server`: install runs + routes).
> Owner: TBD. Status: DRAFT.
> Depends on: auth gate (locked), `env-core` ids (locked), shared `exec`
> (locked). Closes research task T00-04 (initial values; nulls tracked).
> Gate: approve before catalog package and Store routes are built.

## 1. Objective

Replace the hardcoded Termux-only `INSTALL_ITEMS` (`terwo/panel.js:438-465`)
with a data-driven per-OS catalog (`termux|debian|arch|alpine|fedora|rhel|
macos|wsl2|windows`) plus thin Store routes (list/start/log with a 500-line
ring), so 1-click installs resolve to the right command per environment and
unknown combinations fail with an actionable message instead of a wrong
command.

Success: Termux behavior byte-parity (same 26 items, checks, commands);
other environments resolve confident mappings and answer `unavailable`
where unverified; install runs stream logs exactly like Terwo.

## 2. API Contract (TypeScript)

```ts
// packages/pkgman/src/catalog.ts
import type { EnvId } from '@olp/env-core';
export interface CatalogItem {
  id: string; name: string; desc: string;
  check?: string;              // shell probe (default `command -v <bin> …`)
  bin?: string;
  forcedInstalled?: boolean;   // e.g. nodejs on Termux/known-good hosts
  install: Partial<Record<EnvId, string>>; // missing env → unavailable
}
export const CATALOG: readonly CatalogItem[];
export function itemById(id: string): CatalogItem | undefined;
export function installCommand(item: CatalogItem, env: EnvId): { ok: true; cmd: string } | { ok: false; reason: string };
export function checkCommand(item: CatalogItem): string;

// apps/server/src/store.ts
export interface InstallRun { logs: string[]; running: boolean; exitCode: number | null }
export interface StoreOptions {
  env: EnvId; home: string;
  check: (cmd: string) => Promise<boolean>;   // 8 s probe (defaultExec-backed in prod)
  spawnShell: (cmd: string, cwd: string, onData: (chunk: string) => void, onDone: (code: number | null, err: Error | null) => void) => { kill(): void };
  notify?: (text: string) => void;            // telegram hook (absent until telegram spec lands)
}
export function registerStoreRoutes(app: FastifyInstance, opts: StoreOptions): void;
// GET /api/install → {items:[{id,name,desc,installed,installing}]}
// POST /api/install/:id/start → {ok:true} (400 unknown/already-running/unavailable)
// GET /api/install/:id/log → {logs, running, exitCode} (empty shape when never run)
```

### Behavior

- Catalog v1: all 26 Terwo items with identical `id/name/desc/check/bin` and
  identical Termux commands (verbatim). Non-Termux `install` values are
  best-effort initial mappings (apt/pacman/apk/dnf/brew/npm/curl); any cell
  not confidently known is **absent** (`undefined`) → `installCommand`
  returns `{ok:false, reason:'Install command unavailable for <env> (<id>)'}`.
  Absent cells are tracked as `tbd-verify`, never guessed at runtime.
- `termux-api` is Termux-only (absent elsewhere); `bun` keeps its upstream
  installer with the known Android caveat in `desc`; `nodejs` keeps
  `forcedInstalled` on Termux only (elsewhere it resolves per env).
- Debian/Ubuntu Node.js resolves to the NodeSource 22.x setup pipeline
  (ADR-001); commands are sudo-free (privilege model is an open question —
  same single-user philosophy as Terwo: the server runs as a user that can
  install).
- List: per item, `installed` = `forcedInstalled || await check(checkCommand)`
  (8 s timeout, false on error); `installing` from the runs map. Shape
  `{items}` identical to Terwo.
- Start: unknown id → 400 `Unknown package`; running → 400 `Installation
  already running`; unavailable env/package → 400 reason; else spawn
  `bash -c <cmd>` with `cwd: home`, push `$ <cmd>\n` first, ring-trim 500,
  exit banner `\n--- finished (exit <code>) ---\n` (English; legacy
  `selesai` translated), spawn-error banner `\n--- failed: <msg> ---\n`,
  `notify('✅'/'❌' + ' Install <name> finished (exit <code>)')` when a
  notifier is wired (no-op until telegram lands — Terwo `sendTelegram`
  parity by seam, not by import).
- Log: never-run id → `{logs:'', running:false, exitCode:null}` (no 404,
  Terwo parity).
- Route id pattern `[a-z0-9-]+` (Terwo parity `panel.js:1503`).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/pkgman && npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/pkgman && npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
packages/pkgman/
  src/catalog.ts
  src/index.ts
  test/catalog.test.ts
  package.json (name @olp/pkgman, zero runtime deps)
  tsconfig.json
apps/server/src/store.ts
apps/server/test/store-routes.test.ts
```

## 5. Code Style

```ts
// Good: data + pure resolution, no exec imports in the catalog.
export function installCommand(item: CatalogItem, env: EnvId) {
  const cmd = item.install[env];
  return cmd === undefined ? { ok: false as const, reason: `Install command unavailable for ${env} (${item.id})` } : { ok: true as const, cmd };
}
```

- Catalog entries sorted by `id` (diff-friendly); English `desc`; JSDoc on all exports.

## 6. Testing Strategy

- `packages/pkgman` (Vitest, zero I/O): every item has `id/name/desc` + at least a Termux command; ids unique; `installCommand` matrix (termux resolves all 26; spot-check debian/arch/alpine entries; absent cell → reason names env + id); `checkCommand` default shape.
- Server (inject + fakes): list flags (forced/installed/installing); start unknown/running/unavailable 400s; run records `$ cmd`, streams fake output chunks, ring-trims at 500, exit banner + exitCode, notifier called with ✅/❌ text; spawn-error path sets `exitCode: -1`; log empty-shape + live content; gate 401 on one route.
- Coverage: all validation + notifier branches.

## 7. Boundaries

- Always: resolve-then-spawn (never execute an unchecked id); ring caps; English banners.
- Ask first: filling a `tbd-verify` cell (needs per-OS evidence or on-device check); privilege escalation (`sudo`/polkit); adding items.
- Never: run install commands for another env; log secrets (commands contain none by construction — catalog review must keep it so); auto-install without an explicit start call.

## 8. Success Criteria

- [ ] Termux Store behaves identically (items, checks, commands, log shapes).
- [ ] Every non-Termux cell is either a verified command or an explicit unavailable with reason (no silent wrong commands).
- [ ] `tbd-verify` list exported from the spec appendix for Phase 4 fill-in.

## 9. Open Questions

- Privilege model on sudo-based distros (passwordless sudo? run-as-root docs? polkit?) — follow-up ADR before installers ship.
- Post-install service notes per OS (e.g. `initdb`, `mysql_install_db`) — README follow-up with `pkgman` desc links.

## 10. Decisions

- Catalog lives in its own zero-dep package (per PLAN layout); telegram notify is a seam (`notify?`), not an import.
- `tbd-verify` appendix (initial, Phase 4 fill-in): cloudflared debian(repo setup), mariadb/postgres per-OS service names + init steps, cronie naming per distro (debian `cron`), bun on Android (known-broken upstream), all `rhel`/`macos`/`wsl2`/`windows` cells except npm/curl-universal items.

## Appendix — tbd-verify cells (non-exhaustive)

- `cloudflared`: debian/ubuntu (vendor repo), arch (AUR vs extra), alpine, fedora.
- `mysql`/`postgres`: service/init differences per OS (server/client split packages).
- `cronie`: debian (`cron`), alpine (busybox crond vs `apk add`), macos (launchd note).
- `bun`: Android Termux (no upstream build — keep caveat).
- `rhel`, `macos`, `wsl2`, `windows`: all cells except npm-install (`pm2`, `9router`) and curl-script (`nvm`, `bun`, `hermes`) items.
