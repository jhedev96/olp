# SPEC — store extras wave 7 (versions, update/upgrade, conf link, mirror)

> Module ids: `pkgman` (catalog data + manager commands) + `server`
> (`store.ts` only — no new package). Owner: TBD.
> Status: DRAFT (wave direction locked 2026-10-12, human Q&A).
> Depends on: existing store runs machinery + install catalog.
> Gate: approve before W7-01 (first code).

## 1. Objective

Close CAND-027's shippable core: installed versions per card, Update
Repo + Batch Upgrade wired to real manager commands, conf path +
Configure (catalog data, client-side Files deep-link), and an honest
mirror/latency card. Full per-env mirror detection splits to
CAND-036 (needs per-OS evidence).

Success: every card shows a version or an honest placeholder; repo
update and system upgrade run in the existing log-modal machinery;
Configure lands in Files at the conf path; smoke proves
versions/update/mirror live.

## 2. API Contract (TypeScript)

```ts
// packages/pkgman/src/catalog.ts (additive fields)
export interface CatalogItem {
  /* ...existing... */
  /** Full shell snippet printing the version (first line used, capped).
      Absent → derived from bin (`<bin> --version 2>&1 | head -n 1`);
      null when neither (honest unknown, e.g. termux-api). */
  versionCmd?: string;
  /** Static conf path for the card (display only, never executed;
      may contain $PREFIX/$HOME — expanded client-side for display). */
  conf?: string;
}
export function versionCommand(item: CatalogItem): string | null;
export function updateCommand(env: EnvId): { ok: true; cmd: string } | { ok: false; reason: string };
export function upgradeCommand(env: EnvId): { ok: true; cmd: string } | { ok: false; reason: string };

// apps/server/src/store.ts
// GET /api/install -> {items:[{id,name,desc,installed,installing,conf}]} (conf additive, static)
// GET /api/install/versions -> {versions: Record<string, string | null>}
// POST /api/install/update/start -> { ok: true }
// GET /api/install/update/log -> { logs, running, exitCode } (empty shape never-run)
// POST /api/install/upgrade/start -> { ok: true }
// GET /api/install/upgrade/log -> { logs, running, exitCode }
// GET /api/install/mirror -> { manager: string | null; mirror: string | null; latencyMs: number | null }
```

### Behavior

- Versions: probed in parallel (`Promise.all`, 8 s cap each via the
  `exec` seam defaulting to `defaultExec`), first stdout line capped
  at 120 chars; only installed items spawn a probe (presence reuse via
  the existing `check` seam — uninstalled → null without spawning);
  any failure → null (never fails the endpoint).
- Update/upgrade: manager-native single commands per env, sudo-free
  (existing privilege model — server user installs):
  termux `pkg update` / `pkg upgrade -y`; debian/wsl2 `apt-get update` /
  `apt-get upgrade -y`; arch `pacman -Sy` / `pacman -Su --noconfirm`;
  alpine `apk update` / `apk upgrade`; fedora/rhel `dnf makecache` /
  `dnf upgrade -y`; macos `brew update` / `brew upgrade`; windows null
  (honest unavailable → 400 reason). Runs reuse the extracted
  `startRun` helper (same `$ cmd` banner, 500-line ring, exit banner,
  `notify` seam); separate ops map (`update`/`upgrade` slots, busy →
  400 `already running`). Explicit static routes registered before the
  parametric `:id` routes + a test proving `/update/start` never hits
  `Unknown package`.
- Mirror: termux-only honest — manager `pkg`, mirror = first-host
  parsed from `$PREFIX/etc/apt/sources.list` (first `deb` line),
  latencyMs = wall-time of a validated-hostname `dns.lookup` (3 s race
  → null, never throws). Other envs: `{manager: <per-env binary>,
  mirror: null, latencyMs: null}` (CAND-036 follow-up). `prefix`
  arrives via `StoreOptions.prefix` (prod: `process.env['PREFIX']`
  fallback, tests: tmp dir).
- Frontend: versions fetched once per mount (per-card line: version
  string or muted `—`); conf shown + Configure button navigates to
  Files via a new `?path=` deep-link (router `navigate` gains optional
  query; files page consumes on mount through the existing jail —
  traversal still errors honestly); Update Repo / Batch Upgrade buttons
  wired to start endpoints reusing the log modal (logView generalized
  to `{kind, id, label}` + log-url map); Installed Only client toggle;
  mirror card (values or honest `—`); ComingSoon CAND-027 drops.
- `versionCmd` values land from a W7-01 evidence spike (each override
  verified against a real binary where present; `--version` default
  kept where it works, overrides only where evidence demands).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/pkgman && npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/pkgman && npm run test --workspace=@olp/server
Smoke: live versions shape → update empty-log → update start → poll ≤30 s completes → mirror shape → cleanup
```

## 4. Project Structure

```text
packages/pkgman/src/catalog.ts            # versionCmd/conf fields + manager commands
packages/pkgman/test/catalog.test.ts      # + matrix (extends file)
apps/server/src/store.ts                  # versions/update/upgrade/mirror (one domain file)
apps/server/src/index.ts                  # prefix/exec wiring
apps/server/test/store-routes.test.ts     # + cases (extends file)
smoke/linux.mjs                           # + store extras checks
apps/web/src/pages/store.tsx              # wiring (W7-04)
apps/web/src/pages/files.tsx              # ?path= consume (small)
apps/web/src/lib/router.ts                # optional query in navigate
```

## 5. Code Style

- Catalog entries stay sorted by `id`; manager commands named
  constants per env (no inline strings in routes).
- Hostname validated `/^[a-z0-9.-]+$/i` before `dns.lookup` (parsed
  file content is untrusted input).
- No `any`; English JSDoc; caps as named constants (8 s probe,
  120-char version, 3 s dns race, 500-line ring reuse).

## 6. Testing Strategy

- pkgman (zero I/O): every item has `versionCommand` decision
  (default-derived vs override vs null — snapshot the mapping);
  update/upgrade matrix per env (termux/debian/arch/alpine/
  fedora/macos resolve; windows null with reason naming env).
- server (inject + fakes): versions parallel + installed-gating (no
  spawn for uninstalled) + cap/failure→null + 401; update/upgrade
  start/log reuse (busy 400, unavailable-manager 400, empty-shape log,
  banner + notify parity); static-beats-parametric proof
  (`/update/start` ≠ `Unknown package`); mirror termux parse + bad
  hostname + dns-timeout nulls + non-termux null shape.
- smoke (behavioral): versions is an object of string|null; update log
  empty-shape → start ok → poll completes (exit code recorded, honest
  fail allowed offline — never hangs); mirror `{manager:'apt-get',
  mirror:null, latencyMs:null}` on Linux.
- frontend: versions render/placeholder, update/upgrade post + modal
  reuse, conf Configure navigates with `?path=`, installed-only
  filter, mirror nulls, CAND-027 gone.

## 7. Boundaries

- Always: session gate; catalog-derived commands only (no user input
  reaches a shell — schedule names/paths aside, none here);
  sudo-free; caps enforced.
- Ask first: filling windows manager cells; per-env mirror detection
  (CAND-036 scope); purge-cache button (mockup EXPERIMENTAL —
  destructive-adjacent, needs confirm design).
- Never: auto-update/upgrade without an explicit start call; per-item
  upgrade loops (manager-native only); executing conf paths; trusting
  sources.list content (hostname validation mandatory).

## 8. Success Criteria

- [ ] pkgman + server builds green; inject suites green.
- [ ] Smoke extras checks green live (honest fail allowed offline,
  hang never).
- [ ] Store page wired; CAND-027 closed (minus per-env mirror → 036).
- [ ] Existing 3-endpoint behavior diff-empty (list gains additive
  `conf` only).

## 9. Open Questions

- Purge-cache EXPERIMENTAL button (mockup): `pkg clean`-class per env
  — needs confirm-dialog design; candidate for the CAND-036 wave or
  its own small task.
- Windows manager mapping (`winget upgrade --all`?): stays null until
  a Windows smoke box exists.

## 10. Decisions (locked 2026-10-12, human Q&A)

- Versions via dedicated `GET /api/install/versions` (not inline —
  list keeps its current cost).
- Mirror wave 7 = Termux-honest + nulls elsewhere; full per-env
  detection → CAND-036.
- Conf = catalog static data + client-side Files `?path=` link (no
  conf-serving endpoint).
- Batch Upgrade = one manager-native upgrade-all (not a reinstall
  loop).

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Per-card versions (`nginx v1.24.0`) | versions endpoint (parallel probe, honest nulls) |
| Update Repo (`pkg update`) | update start/log (manager-native per env) |
| Batch Upgrade | upgrade start/log (manager-native upgrade-all) |
| Conf path + Configure | catalog `conf` + Files `?path=` deep-link |
| Installed Only toggle | client-side filter (no backend) |
| Mirror + APT latency card | mirror endpoint (termux parse + dns timing; nulls elsewhere → 036) |
| Storage bar | existing disk stats (already real, untouched) |
| Purge Cache EXPERIMENTAL | OUT (confirm design needed) |
| Per-card service actions (Start/Restart/Status) | OUT — owned by services/database waves, linked not rebuilt |
