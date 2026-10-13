# SPEC — auth-config bundle wave 17 (CAND-038, reauth + rollback + revoke)

> Modules: `packages/auth` (parse export), `server` (`backup.ts`
> restore-auth step + manifest `hasAuth`, `index.ts` session-revoke
> wiring) + `web` (backup restore-all password field) + smoke.
> No new dep. Owner: TBD. Status: DRAFT (locked 2026-10-13, human
> Q&A: option A + reauth + rollback + revoke-all).
> Depends on: wave-16 jobs (snapshot/restore-all, manifest IO).
> Gate: approve before W17-01 (first code).

## 1. Objective

Close CAND-038: snapshots include the admin credential file and
restore-all replays it **last**, behind re-authentication, with an
automatic rollback copy and full session revocation — so a
credential restore can never silently lock out the operator or
leave stale sessions alive.

Success: bundle configs zips carry `auth.json`; restore-all with a
correct current password and an `auth.json` part ends logged-out
with the bundled credentials live and a rollback file on disk;
wrong password / corrupt auth writes zero bytes; suites green.

## 2. API Contract (TypeScript)

```ts
// Manifest gains one optional field (absent = pre-038 bundle = no auth, honest):
export interface BundleManifest { id: string; created: number; parts: BundlePart[]; hasAuth?: boolean }
// POST /api/bundles/:id/restore { currentPassword?: string }
//   (unchanged shape; currentPassword required iff manifest.hasAuth === true)
// restore-auth step detail strings:
//   ok: 'credentials restored (logged out)'
//   fail-closed: 'Current password required' | 'Current password is wrong' |
//     'Auth backup is missing' | 'Invalid auth in bundle'
```

### Behavior

- Snapshot: configs staging adds `auth.json` (verbatim copy of
  `dataDir/config.json`) when present; sets manifest `hasAuth`
  true/false accordingly. Missing `config.json` (fresh boot race)
  reads as `hasAuth: false`, never fails the step.
- Restore-all step order: DB parts → configs → crons →
  **restore-auth last** (credentials change only after everything
  else replayed).
- `restore-auth` runs only when `manifest.hasAuth === true`;
  otherwise the step is skipped silently (no step row — nothing to
  do, same as absent configs/crons parts).
- Fail-closed order inside the step (zero writes until all pass):
  1. `currentPassword` present and non-empty, else
     `Current password required`.
  2. Read live `config.json`; `verifyPassword(currentPassword,
     live.salt, live.hash)`, else `Current password is wrong`.
     Unreadable live config fails the same way (never proceed
     blind).
  3. Read + shape-validate bundled `auth.json` (username
     non-empty string, salt/hash non-empty strings, passkeys array
     passthrough — reuse a new `parseAuthConfig` export from
     `@olp/auth`, thin wrapper over its `normalize`), else
     `Invalid auth in bundle`.
  4. Write rollback `config.json.pre-restore-<stamp>` (0600) with
     the live bytes.
  5. Write `config.json` (0600) with the bundled bytes.
  6. `revokeAll()` sessions (wired from the auth context via
     `BundleDiscovery.revokeSessions`; the operator is logged out
     immediately and logs back in with the restored credentials).
- Logout consequence: the restore poll (`GET
  /api/bundles/restores/:id`) 401s after revocation. Frontend
  treats 401 mid-restore-poll as the expected logout (shows "log
  in with the restored credentials", redirects to login) — the
  final step report is best-effort visible, never assumed.
- Rollback itself is manual (Files download/edit + documented);
  no auto-rollback endpoint in this wave.
- Bundled passkeys restore as part of the config bytes (documented;
  24h passkey sessions die with the revoke like everything else).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server && npm run build --workspace=@olp/auth
Test:  npm run test --workspace=@olp/server
Smoke: snapshot (hasAuth true) -> restore-all WITH password -> logged out (401) ->
  login with bundled creds works -> cleanup. Live run deferred with phase 26 (box OOM).
```

## 4. Project Structure

```text
packages/auth/src/config.ts        # export parseAuthConfig (W17-01)
packages/auth/test/config.test.ts  # + cases if absent (W17-01)
apps/server/src/backup.ts          # hasAuth stage/read + restore-auth step (W17-02)
apps/server/src/index.ts           # revokeSessions wiring (W17-02)
apps/server/test/backup-bundle*.test.ts  # + cases (W17-02)
smoke/linux.mjs                    # + auth checks (W17-03)
apps/web/src/pages/backup.tsx      # password field + logout copy (W17-04)
apps/web/test/backup.test.tsx      # + cases (W17-04)
```

## 5. Code Style

- Auth bytes stay `0600` everywhere (stage copy, rollback, live
  write — reuse the sidecar/mode pattern).
- No new fs surface: live/rollback IO goes through the
  `BackupSystem` (string read/write); only shape parsing comes
  from `@olp/auth`.
- No `any`; English JSDoc; the step never throws (fail-closed
  strings only, same as W16 steps).

## 6. Testing Strategy

- `parseAuthConfig`: valid (incl. legacy missing-username →
  `admin`), corrupt (missing salt/hash, non-object) throws.
- Restore-auth (memory fakes): wrong password → failed, zero
  `writeFile` calls to `dataDir/config.json`, no revoke call;
  missing password with `hasAuth` → failed closed; corrupt
  bundled auth → failed, live bytes untouched; success →
  rollback file written with live bytes (0600), live config
  equals bundled bytes, revoke called once; `hasAuth: false`
  bundles gain no step.
- Manifest back-compat: pre-038 manifests (no `hasAuth`) read as
  `hasAuth` absent → no auth step, restore works unchanged.
- Smoke (behavioral, deferred): password-gated restore → 401 →
  re-login green. DB parts stay inject-only (recorded).
- Frontend: password field appears iff manifest `hasAuth`;
  401 mid-poll shows logout copy; CAND-038 gone.

## 7. Boundaries

- Always: session gate on the restore endpoint; reauth before
  any auth write; rollback before overwrite; revoke after write;
  0600 on every credential byte.
- Ask first: auto-rollback endpoint; cross-panel auth import;
  password-less auth restore for "I lost everything" flows
  (filesystem reset stays the answer).
- Never: restore auth without the current password; skip the
  rollback; leave sessions alive across a credential change;
  log or return credential bytes in any response.

## 8. Success Criteria

- [ ] Auth + server builds green; inject suites green.
- [ ] Smoke auth checks green live (or recorded-deferred with
  phase 26).
- [ ] Backup page wired; CAND-038 closed.
- [ ] Existing bundle behavior diff-empty for `hasAuth: false`
  (additive only).

## 9. Open Questions

- None (locked 2026-10-13). Retention/auto-prune stays a
  separate design (noted since wave 6).

## 10. Decisions (locked 2026-10-13, human Q&A)

- Option A: include + guarded restore (over export-only B,
  wontfix C).
- Reauth with the current password: yes (over dialog-only).
- Automatic rollback copy: yes (`config.json.pre-restore-<stamp>`).
- Revoke all sessions incl. the operator: yes (immediate logout).
- Manifest carries `hasAuth` (over zip-peek endpoint) so the UI
  knows when to ask for the password.

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Full System Snapshot card ("All databases, crons & configs") | unchanged card; auth rides the configs part (no new card) |
| (no mockup element — safety feature) | restore-all dialog gains password field + logout copy iff `hasAuth` |
