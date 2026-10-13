# SPEC — per-env mirror + purge wave 15 (deferred live)

> Modules: `pkgman` (source descriptors + parsers + purge map) +
> `server` (`store.ts` only) + `web` (header button + mirror card).
> No new dep. Owner: TBD.
> Status: DRAFT (locked 2026-10-13, human Q&A).
> Depends on: wave-7 mirror/update/upgrade machinery.
> Gate: approve before W15-01. LIVE DEFERRED (box OOM — smoke
> written now, run when memory breathes; merge gated on green
> like wave 14).

## 1. Objective

Close CAND-036: per-OS mirror detection (apt incl. DEB822 +
`.d` dirs, pacman mirrorlist, apk repositories, yum repofiles
with baseurl-only honesty, brew remote attempt, nulls elsewhere)
and a purge-cache op (third ops slot, confirm-guarded) in the
store header.

Success: debian shows its first sources host + dns latency;
arch/alpine/fedora resolve their native files; brew attempts
its git remote (null on any failure); purge runs manager-native
clean with modal logs; suite green; live ALL GREEN when the box
allows (same gate as wave 14).

## 2. API Contract (TypeScript)

```ts
// packages/pkgman/src/catalog.ts (or mirrors.ts — implementer picks, keeps catalog.ts focused)
export interface MirrorSource { kind: 'apt' | 'pacman' | 'apk' | 'yum' | 'brew'; file?: string; dir?: string; ext?: string }
export function mirrorSource(env: EnvId): MirrorSource | null;
 // termux/debian/wsl2 apt (prefix-joined for termux, absolute otherwise);
 // arch pacman mirrorlist; alpine apk repositories; fedora/rhel yum .repo dir;
 // macos brew (exec-based); windows null
export function parseAptMirror(text: string): string | null;   // deb lines + DEB822 URIs:
export function parsePacmanMirror(text: string): string | null; // first Server = URL
export function parseApkMirror(text: string): string | null;    // first http(s) token
export function parseYumMirror(text: string): string | null;    // first baseurl URL (mirrorlist-only -> null, documented)
export function parseBrewRemote(gitconfig: string): string | null; // [remote "origin"] url =
export function purgeCommand(env: EnvId): { ok: true; cmd: string } | { ok: false; reason: string };
// termux `pkg clean`; debian/wsl2 `apt-get clean`; arch `pacman -Sc --noconfirm`;
// alpine `apk cache clean`; fedora/rhel `dnf clean all`; macos `brew cleanup`; windows null

// apps/server/src/store.ts
// StoreOptions += listSourceDir?: (dir: string) => string[] (default readdir try->[])
// GET /api/install/mirror -> { manager, mirror, latencyMs } (same shape; per-env resolution)
// POST /api/install/purge/start -> { ok: true } (400 busy/unavailable)
// GET /api/install/purge/log -> { logs, running, exitCode } (empty shape never-run)
```

### Behavior

- Candidate files: termux `join(prefix, etc/apt/sources.list)`;
  debian/wsl2 `/etc/apt/sources.list` + sorted `*.list` under
  `/etc/apt/sources.list.d`; arch `/etc/pacman.d/mirrorlist`;
  alpine `/etc/apk/repositories`; fedora/rhel sorted `*.repo`
  under `/etc/yum.repos.d`. First parse hit wins; all missing
  → null (never throws, never guesses).
- Brew attempt (human-locked): `exec('brew --repository')`
  (8 s cap, existing seam) → trim/first-line → validate
  (absolute, no `..`/newline/quotes) → `join(repo,
  '.git/config')` → `readSourceFile` → `parseBrewRemote` →
  hostname → shared dns-latency path. ANY failure → null
  (same honest-null as every other env).
- Hostname rule shared with wave 7 (dot/colon required —
  reuse the check, no second implementation; refactor
  `parseMirrorHost` to expose/extend, implementer picks the
  seam but deletes no behavior).
- Fedora `mirrorlist=`-only repofiles → null (the metalink
  host is metainfo, not a package mirror — claiming it would
  lie; documented here, not revisited without evidence).
- Purge reuses the ops map (`purge` slot, busy 400, manager
  unavailable 400, `$ cmd` banner + ring + exit banner +
  `notify` ✅/❌ `Cache purge finished`). Static routes stay
  before parametric `:id` (wave-7 lesson + test).
- Frontend: header Purge button (enabled, after Batch upgrade)
  → ConfirmDialog ("Remove downloaded package archives?
  Installed software stays.") → start → shared log modal
  (`kind: 'purge'`, title `Cache purge`); mirror card renders
  whatever the endpoint resolves (no client change expected —
  nulls already render `—`).
- No archive/content execution anywhere (same gate as wave 6).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/pkgman && npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/pkgman && npm run test --workspace=@olp/server
Smoke: live mirror shape (manager apt) + purge start -> poll completes -> modal-shape log (DEFERRED with wave-14 gate)
```

## 4. Project Structure

```text
packages/pkgman/src/catalog.ts (or mirrors.ts)  # descriptors + 5 parsers + purge map (W15-01)
packages/pkgman/test/catalog.test.ts            # + matrix (extends file)
apps/server/src/store.ts                        # per-env mirror + purge slot (W15-02)
apps/server/src/index.ts                        # listSourceDir wiring (default fs)
apps/server/test/store-routes.test.ts           # + cases
smoke/linux.mjs                                 # + mirror/purge checks (written W15-03, RUN deferred)
apps/web/src/pages/store.tsx                    # purge button + modal kind (W15-04)
apps/web/test/store.test.tsx                    # + cases
```

## 5. Code Style

- One parser per format (table-driven where trivial, never a
  shared mega-regex); every parser total (null on garbage).
- No `any`; English JSDoc; caps as named constants (8 s exec,
  3 s dns, 120-char version reuse untouched).

## 6. Testing Strategy

- pkgman (zero I/O): descriptor per env (7 managers +
  windows null); parser matrix (deb + DEB822 + junk,
  Server-line + comments, apk tags, yum baseurl vs
  mirrorlist-only-null, brew remote + missing-section null);
  purge matrix (6 resolvers + windows null with reason).
- server (inject + fakes): mirror per-env via fake
  readSourceFile/listSourceDir (debian multi-file first-hit,
  arch, alpine, yum, termux-prefix preserved, brew
  exec-happy + exec-fail + path-reject nulls, empty → null
  shape); purge start/log/busy/unavailable/notify parity;
  static-beats-parametric for `/purge/start`; 401 gates.
- smoke (behavioral, DEFERRED): mirror `{manager:'apt'}`
  shape + purge start→completes→log-done (apt-get clean is
  fast + harmless).
- frontend: purge posts + modal reuse + dialog copy;
  mirror card unchanged-rendering proof (values + nulls).

## 7. Boundaries

- Always: session gate; catalog-fixed commands only;
  sudo-free; caps enforced; brew path validated before join.
- Ask first: filling windows cells; metalink-host display;
  raising caps.
- Never: executing repo file contents; trusting
  `sources.list` hostnames without the dot/colon rule;
  auto-purge without an explicit start call.

## 8. Success Criteria

- [ ] pkgman + server builds green; inject suites green.
- [ ] Smoke mirror/purge checks green live (DEFERRED ok).
- [ ] Store page wired; CAND-036 closed on code; merge gated
  on live green (wave-14 rule).
- [ ] Existing 8-endpoint behavior diff-empty (mirror shape
  unchanged, list untouched).

## 9. Open Questions

- Brew remote slowness on real macs (2 execs + dns):
  field evidence wanted; null-fallback keeps it safe.
- `dnf clean all` vs `dnf clean packages`: chose all
  (metadata refreshes on next use — standard).

## 10. Decisions (locked 2026-10-13, human Q&A)

- Brew: attempt remote parse (any failure → null), not
  honest-null-up-front.
- Purge: header button (third ops slot), confirm-guarded.

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Mirror + APT latency card | per-env mirror endpoint (first-host + dns timing) |
| Purge Cache EXPERIMENTAL | purge slot (manager-native safe-clean set + dialog; EXPERIMENTAL tag dropped — behavior defined) |
