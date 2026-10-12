# SPEC — backup advanced wave 6 (verify, gzip, upload, schedules)

> Module ids: `server` (`backup.ts` only — no new package). Owner: TBD.
> Status: DRAFT (wave direction locked 2026-10-12). Depends on:
> existing backup engines + `cron-schedule.ts` (nextRun reuse).
> Gate: approve before W6-02 (first code).

## 1. Objective

Close CAND-029's shippable core: SHA256 integrity (stored at create,
verified on demand), gzip dump variant, archive upload import, and
scheduled snapshots with an in-process ticker. Full-system bundle is
explicitly OUT (cross-domain orchestration needs a job-runner design
— split to CAND-035, see §10).

Success: every archive carries a hash; dumps optionally gzip; foreign
archives import with validated metadata; schedules fire while the
panel runs; smoke proves upload/verify/schedule live.

## 2. API Contract (TypeScript)

```ts
// Sidecar additive field (old sidecars without it verify as unknown):
export interface BackupMeta { /* ...existing... */ sha256?: string }

// POST /api/backups { type, name?, source?, gzip?: boolean }
//   mysql/postgres + gzip:true → `<name>.sql.gz` via `| gzip` / restore via `gzip -dc |`
// GET /api/backups/:name/verify -> { ok: true, sha256: string, match: boolean | null }
//   match null when the sidecar predates hashing (honest unknown)
// POST /api/backups/upload { name?, type: 'folder'|'mysql'|'postgres', data: base64 }
//   50 MB cap (files-upload parity), sidecar source 'upload', sha256 stored
//   bodyLimit 51 MB, invalid type/name/data → 400
// Schedules:
// GET /api/backups/schedules -> { schedules: BackupSchedule[] }
// POST /api/backups/schedules { name?, type, source, schedule, enabled? } -> { ok: true, schedule }
// DELETE /api/backups/schedules/:id -> { ok: true }
// POST /api/backups/schedules/:id/toggle -> { ok: true }
export interface BackupSchedule {
  id: string; name: string; type: BackupType; source: string;
  schedule: string; enabled: boolean; created: number;
  lastRun: number | null; lastStatus: 'ok' | string | null;
}
```

### Behavior

- Hashing: node:crypto sha256 over the archive stream (no new exec
  surface); stored in the sidecar at create (all three engines +
  upload); verify recomputes and compares (constant-time compare not
  required — same-box integrity, not auth).
- Gzip: `gzip: true` only affects mysql/postgres (`mysqldump … |
  gzip > f.sql.gz`, `pg_dump … | gzip > f.sql.gz`; restore
  `gzip -dc f | mysql/psql …`); folder ignores the flag (zip already
  compresses — documented, not an error). Filenames carry `.sql.gz`;
  download serves bytes as-is.
- Upload: base64 → Buffer (50 MB cap, files parity); name sanitized
  with existing `sanitizeBackupName` (fallback `upload-<stamp>`);
  sidecar `{type, source: 'upload', sha256}`; restore works by type
  (folder unzip / db pipe-in — same code paths, no forks).
- `writeFile` accepts `string | Buffer` (node handles both; memory
  fakes store as-is).
- Schedules: `backup-schedules.json` in the backups dir (0600,
  corrupt → []); id = 8 hex chars; schedule validated as 5-field
  (same regex as cron create); ticker every 60 s (named constant):
  due = enabled && `nextRunMs(schedule, lastRun ?? 0) <= now` →
  run create-equivalent inline (name auto `name-<stamp>`? No —
  scheduled runs REUSE the schedule name with a stamp suffix:
  `${name}-${backupStamp()}`), record lastRun/lastStatus (error
  message capped 200 chars on failure, never throws out of the tick).
- Ticker ownership: `startBackupScheduler(opts): () => void` (stopper);
  `index.ts` starts it (prod, no stop); tests drive the pure
  `dueSchedules(schedules, nowMs)` + schedule CRUD (no waiting).
- Ticker executes as the panel user with stored configs (same trust
  as manual create — no new privilege).
- Frontend: per-row Verify button → hash badge (match/unknown);
  gzip checkbox in create (db types only); Upload Archive button +
  type select; schedules section (form + list + toggle/delete +
  last-run line); ComingSoon CAND-029 drops. Full-system UI: none
  (CAND-035).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
Smoke: live folder backup → verify match → upload round-trip → `* * * * *` schedule fires (~70 s wait) → cleanup
```

## 4. Project Structure

```text
apps/server/src/backup.ts                # hash/upload/gzip/schedules/ticker (one domain file)
apps/server/src/index.ts                 # startBackupScheduler wiring
apps/server/test/backup-routes.test.ts   # + cases (extends file)
smoke/linux.mjs                          # + backup advanced checks
apps/web/src/pages/backup.tsx            # wiring (W6-06)
```

## 5. Code Style

- Shell quoting via existing `quote()`; identifiers never interpolated
  raw (schedule names go through `sanitizeBackupName`).
- Caps as named constants (50 MB upload, 60 s tick, 200-char status).
- No `any`; English JSDoc; 0600 on new persisted files.

## 6. Testing Strategy

- routes (memory fakes): hash stored at create (all engines via
  fake exec), verify match/unknown/missing, gzip command shape in
  recorded exec strings + `.sql.gz` naming, upload validation caps +
  round-trip restore path reuse, schedules CRUD + toggle + validation,
  dueSchedules pure matrix, ticker success/failure recording (drive
  the tick fn directly, no waiting).
- hashing streams: fake `streamFile` content → known sha256 vector.
- smoke (behavioral): folder backup → verify `match:true` →
  download → upload as new name → verify → per-minute schedule →
  poll ≤90 s for lastRun → delete all. Real `zip` required (apt
  present on the smoke box or install first — record).
- frontend: upload posts base64, verify badge states, gzip checkbox
  gating, schedules CRUD + last-run line.

## 7. Boundaries

- Always: session gate; caps; 0600 secrets-adjacent files; short-lived
  conns (db paths reuse existing commands).
- Ask first: raising upload/tick caps; scheduling below 1-minute
  granularity; auto-prune (mockup policy card — needs retention
  design, NOT in this wave).
- Never: full-system bundle (CAND-035); executing archive contents;
  trusting client-supplied hashes (server always recomputes).

## 8. Success Criteria

- [ ] Server build green; inject suite green.
- [ ] Smoke advanced checks green live (incl. ~70 s schedule wait).
- [ ] Backup page wired; CAND-029 closed (minus full-system → 035).
- [ ] Existing 5-endpoint behavior diff-empty (create gains additive
  `gzip` + `sha256` only).

## 9. Open Questions

- Auto-prune retention policy (mockup card): needs design (keep-N?
  keep-days? per-type?) — future wave with CAND-035 or its own.
- Gzip for folder type: zip already compresses — flag ignored
  (documented, not an error). Revisit only if a sparse-file case
  demands tar.gz.

## 10. Decisions (locked 2026-10-12, human)

- Wave 6 = verify + gzip + upload + schedules (029 core); full-system
  splits to CAND-035 (cross-domain orchestration needs a job runner).
- Hash via node:crypto streams (no new exec surface).
- Scheduler = in-process 60 s ticker (panel must run — documented,
  same trust as manual create).

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| SHA256 badges + hash lines | sidecar hash + verify endpoint |
| `.sql.gz` variant | gzip flag (db types) |
| Upload Archive | upload endpoint (50 MB, typed) |
| Scheduled section + last-run + cron link | schedules CRUD + ticker + lastRun/Status (cron-link = navigate, client-side) |
| Full System Snapshot | OUT → CAND-035 |
| Auto-prune card | OUT (retention design needed) |
