# SPEC — ops dummies sweep wave 19 (CAND-013/016/019)

> Modules: `server` (`files.ts` mode+chmod, mounts endpoint,
> log ring + endpoint) + `web` (dashboard log card, files chmod
> UI + mounts card) + smoke. No new dep. Owner: TBD.
> Status: DRAFT (specced 2026-10-13 from human test-drive report).
> Depends on: files jail (`safePath`), env-core env detection.
> Gate: approve before W19-01 (first code).

## 1. Objective

Close three small tracked dummies in one sweep: file modes +
chmod (016), storage mounts card (019), dashboard panel log tail
(013) — each a tiny endpoint plus wiring, no job-runner needed.
Nothing invented: absent sources read as honest empties.

Success: listings carry octal modes, chmod edits round-trip
through the jail, mounts card shows probed roots, dashboard log
card tails real server lines; ComingSoon 013/019 gone; suites
green.

## 2. API Contract (TypeScript)

```ts
// GET /api/files?path= gains per-entry `mode: string | null`
//   (octal '0755' style from st.mode & 0o777; null when stat failed —
//   same best-effort rule as size/mtime today, additive field)
// POST /api/chmod { path: string; name: string; mode: string }
//   -> { ok: true } | 400 { error }
//   (mode must match /^[0-7]{3,4}$/; safePath jail; fsp.chmod;
//   dirs + files both allowed, symlinks never followed —
//   stat-then-chmod on the jailed path only)
// GET /api/mounts -> { mounts: Array<{ path: string; present: boolean; dir: boolean }> }
//   (candidates from env: always PANEL_ROOT; termux adds
//   ~/storage + /storage/emulated/0 when PREFIX smells Termux;
//   other envs add $HOME; probe with stat, never create)
// GET /api/logs?tail=50 -> { logs: Array<{ t: number; level: 'info' | 'warn' | 'error'; msg: string }> }
//   (in-memory ring, cap 200, newest last; tail clamped 1..200;
//   empty array is honest — never seeded or invented)
```

### Behavior

- Mode field is additive: old clients ignore it; `null` keeps
  today's zeroed-stats honesty for unstattable entries.
- Chmod validates before touching fs (bad mode/name/path →
  400, no-op). Symlink entries: `fstat`-free path — open the
  jailed path with `O_NOFOLLOW` semantics via `fsp.chmod` on the
  path itself (documented: chmod follows the link on Linux;
  entries that are symlinks are rejected with 400 — mockup
  symlink health stays CAND-014's problem, not smuggled in).
- Mounts probe read-only (stat only, no mkdir, no writes).
  Termux `~/storage`GRANT state is NOT queried (no Android
  bridge) — `present` reflects fs visibility only, footnoted in
  the card.
- Log ring feeds from a fixed coarse list (no log scraping):
  boot line, login success/failure (username only, never
  passwords), bundle snapshot/restore finish, backup
  create/restore finish, chmod denials. Anything else stays out
  (no per-request access log in this wave).
- Frontend: dashboard log card replaces ComingSoon-013 (tail
  view, no copy/clear buttons — those need a bigger design, cut
  with record); files rows show mode + chmod action (reuse the
  rename-dialog input pattern, no `prompt()`); mounts card
  replaces ComingSoon-019 (present/absent badges + footnote).
- No archive-content execution anywhere (standing gate).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
Smoke: chmod round-trip on a throwaway file (mode flips and flips back) ->
  mounts lists PANEL_ROOT present -> logs non-empty after boot line -> cleanup.
```

## 4. Project Structure

```text
apps/server/src/files.ts                 # mode field + chmod route (W19-01)
apps/server/src/mounts.ts (new, ~80 LOC) # candidates + probe + route (W19-02)
apps/server/src/logring.ts (new, ~60 LOC)# ring + feed helper (W19-03)
apps/server/src/index.ts                 # wire mounts/logring, boot feed (W19-01..03)
apps/server/test/files-routes.test.ts    # + chmod/mode cases (W19-01)
apps/server/test/mounts-routes.test.ts (new)   # + probe cases (W19-02)
apps/server/test/logring.test.ts (new)   # + cap/order cases (W19-03)
smoke/linux.mjs                            # + ops checks (W19-04)
apps/web/src/pages/dashboard.tsx         # log card (W19-05)
apps/web/src/pages/files.tsx             # mode/chmod + mounts card (W19-05)
apps/web/test/dashboard.test.tsx apps/web/test/files.test.tsx  # + cases (W19-05)
```

## 5. Code Style

- New modules under ~100 LOC each with written justification if
  exceeded (task rule); no `any`; English JSDoc.
- OS-specific paths live in the mounts module reading
  `Environment` (never `process.platform` in feature code).
- Ring helper pure (append/read/clamp unit-testable without a
  server).

## 6. Testing Strategy

- Mode: listing carries `'0755'`-shaped strings; unstattable →
  `null` (fake stat throw).
- Chmod: 400 on bad mode (`999`, `abc`, `''`), traversal path,
  symlink entry; 200 flips mode and re-lists it; session gate
  401.
- Mounts: fake env termux → storage candidates present/absent
  per fake stat; non-termux → root + home only; no `mkdir` call
  recorded (fake asserts).
- Logring: cap evicts oldest; tail clamp; order newest-last;
  route returns `[]` pre-feed (honest empty).
- Smoke (behavioral): chmod flip/flip-back live, mounts
  contains the jail root, logs contain the boot line.
- Frontend: ComingSoon-013/019 gone; log lines render
  (`textContent` assertions); chmod posts `{path,name,mode}`;
  mounts badges render.

## 7. Boundaries

- Always: session gate on chmod/mounts/logs; jail on every
  path; 400 before any fs write; secrets never logged (the
  feed list is closed — no free-form message passes review
  without a second pair of eyes on PII).
- Ask first: copy/clear buttons on the log card; writable
  probes on mounts; recursive chmod; per-request access logging.
- Never: invent log lines or mount entries; follow symlinks on
  chmod; scrape foreign log files (pm2/journald stay out).

## 8. Success Criteria

- [ ] Server build green; inject suites green.
- [ ] Smoke ops checks green live (or recorded-deferred — box
  OOM, same human gate as phases 24–26).
- [ ] Dashboard + files pages wired; CAND-013/016/019 closed.
- [ ] Existing files behavior diff-empty besides the additive
  `mode` field.

## 9. Open Questions

- Log copy/clear buttons: cut this wave (needs retention +
  PII review) — confirm the cut stands.
- ACL card strings (mockup `0755/0644` + owner): owner names
  need no new endpoint (`uid` from the same stat — include
  `uid: number | null` alongside mode? left to W19-01, capped
  at the additive-field rule).

## 10. Decisions (locked 2026-10-13, human report + proposal)

- One sweep wave for the three small dummies (over three
  separate waves — each too small to stand alone).
- Symlink chmod rejected (health stays CAND-014).
- Log source = server-fed ring (over pm2/journald scraping).
- Mounts = stat-only probes (over storage-permission queries).

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Chmod column + per-file modes | `mode` field + chmod action (ACL card strings → CAND-016 remainder if uid cut) |
| Mounts/shortcuts card | `GET /api/mounts` probe card (Termux storage honest-present only) |
| Panel log tail | `GET /api/logs` card (tail view; copy/clear cut) |
