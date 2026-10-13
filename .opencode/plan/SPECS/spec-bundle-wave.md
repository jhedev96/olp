# SPEC — full-system bundle wave 16 (manifest + job runner)

> Modules: `server` (`backup.ts` bundle job + restore-all,
> `database.ts` discovery if absent, `cron.ts` export/import
> surface) + `web` (backup card + dialog + bundles list). No new
> dep. Owner: TBD. Status: DRAFT (locked 2026-10-13, human Q&A).
> Depends on: wave-6 archives (create/verify/restore reuse),
> wave-4 drivers, wave-5 cron store.
> Gate: approve before W16-01 (first code).

## 1. Objective

Close CAND-035: a Full System Snapshot card that orchestrates a
manifest + parts bundle (all selected DB dumps + configs zip +
crons export, each part a normal verified archive) and a
danger-guarded restore-all that replays the manifest step by step
with live per-step status.

Success: one click snapshots every checked DB + configs + crons
into a manifest bundle; each part verifies/downloads/restores
through existing UI; restore-all replays with a danger dialog
and per-step report; smoke proves orchestration live
(configs+crons+manifest; DB parts via inject — no engines on
the smoke box); suites green.

## 2. API Contract (TypeScript)

```ts
// GET /api/db/:engine/databases -> { databases: string[] } (NEW if absent — verify at implement;
//   mysql SHOW DATABASES minus information_schema/mysql/performance_schema/sys;
//   postgres datnames minus postgres/template0/template1)
// Bundle manifest (persisted `<bundleId>.bundle.json` in backups dir, 0600):
export interface BundlePart { name: string; file: string; kind: 'mysql' | 'postgres' | 'configs' | 'crons'; sha256: string }
export interface BundleManifest { id: string; created: number; parts: BundlePart[] }
// Job record (memory-only while running; manifest persists on success):
export interface BundleJob { id: string; state: 'running' | 'done' | 'failed'; steps: Array<{ key: string; label: string; status: 'pending' | 'running' | 'ok' | 'failed'; detail: string }>; started: number; finished: number | null }
// POST /api/bundles { databases?: { mysql?: string[]; postgres?: string[] }; configs?: boolean; crons?: boolean }
//   (defaults: all discovered DBs + configs + crons) -> { ok: true, id } (202-style: job runs async)
// GET /api/bundles -> { bundles: BundleManifest[] } (newest first)
// GET /api/bundles/:id -> { bundle?: BundleManifest; job?: BundleJob } (job present while/after running)
// POST /api/bundles/:id/restore -> { ok: true, id: restoreJobId } (danger: caller confirms; replays steps async)
// GET /api/bundles/restores/:id -> { job: BundleJob } (per-step live status)
```

### Behavior

- Snapshot job steps: `enumerate` (discover DBs, intersect
  with requested selection) → per-DB `dump-<db>` (REUSE the
  dump pipelines + sidecar+hash path — same bytes as manual
  dumps) → `configs` (stage sites.json + db.json +
  settings.json + proxy files into a tmp dir, zip, sidecar) →
  `crons` (panel jobs export JSON, sidecar as archive part) →
  `manifest` (write `.bundle.json`). Any step fails → job
  `failed` with the step marked (earlier parts stay as normal
  visible archives — honest orphans, deletable, documented).
- Dump part names: `<bundleId>--<engine>-<db>` (sanitized;
  restore reuses the stored source db — same as manual).
- Configs staging: text-JSON copies via the `BackupSystem`
  surface (no new fs surface); zip via the existing `zip -rq`
  pattern; `unzip` + shape-validate (normalize-tolerant)
  BEFORE any overwrite on restore (corrupt backups never
  brick live configs).
- Crons export: panel-managed jobs JSON (NOT raw crontab —
  foreign lines are not ours to replay); restore-all
  re-creates missing jobs only (match name+schedule+command),
  per-step report.
- DB restore-all per part: `DROP IF EXISTS + CREATE` then the
  standard pipe-in (same bins/trust as manual restore);
  per-part failures recorded, job CONTINUES with a final
  `failed-if-any` (partial state visible, never silent).
- Restore-all is always danger-gated client-side (dialog lists
  consequences: drops/recreates DBs, overwrites configs,
  re-adds cron jobs) AND endpoint-safe (session gate; shape
  validation before every write).
- Auth `config.json` excluded from configs parts (CAND-038
  follow-up with careful planning — human-locked).
- Frontend: Full System card (Start → dialog: discovered DB
  checklist pre-checked-all + configs/crons toggles, engines
  with zero DBs shown disabled-honest) + bundles list
  (created, part counts, per-part verify/download/restore
  reuse, restore-all danger button + live step poll 2 s).
- No archive-content execution anywhere (wave-6 gate carries).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
Smoke: live snapshot (no engines on box: configs + crons + manifest shape) -> part verifies -> manifest lists -> cleanup.
  DB-part orchestration via inject only (no MariaDB/Postgres on the smoke box — recorded, not hidden).
```

## 4. Project Structure

```text
apps/server/src/backup.ts                  # bundle types + snapshot/restore jobs + manifest IO (W16-02/03)
apps/server/src/database.ts                # databases list if absent (W16-01)
apps/server/src/cron.ts                    # jobs export/import surface if absent (W16-01)
apps/server/test/backup-routes.test.ts     # + job cases (fake exec, deterministic)
apps/server/test/database-routes.test.ts   # + discovery cases
smoke/linux.mjs                            # + bundle checks (W16-04)
apps/web/src/pages/backup.tsx              # card + dialog + bundles (W16-05)
apps/web/test/backup.test.tsx              # + cases
```

## 5. Code Style

- Job runner: step table `[{key, label, run}]` executed in
  order with status recording (no step knows the runner;
  no runner knows SQL).
- Manifest/part IO reuses sidecar helpers (0600, JSON);
  staging dir `backups/.staging-<id>` removed after zip
  (success AND failure — no litter).
- No `any`; English JSDoc; caps as named constants (poll
  2 s, name caps, 200-char step details).

## 6. Testing Strategy

- Discovery: system-db exclusion matrix per engine (fake
  drivers); empty engines → honest empty lists.
- Snapshot job (memory fakes, sync-resolving exec): full
  run asserts every part sidecar + manifest contents +
  sha match + staging cleaned; selection respected
  (unchecked DB skipped); step failure mid-run marks
  failed with earlier parts intact; double-start same id
  rejected.
- Restore-all (fakes): per-step replay order, shape-guard
  blocks corrupt configs (no write calls recorded),
  missing-job recreation only, final failed-if-any.
- Smoke (behavioral): snapshot → manifest lists parts →
  each part verifies → delete all. DB parts: inject-only
  (recorded).
- Frontend: dialog checklist pre-checked, toggles post
  selection; bundles render; restore-all dialog copy +
  step poll; CAND-035 gone.

## 7. Boundaries

- Always: session gate on all six endpoints; shape-validate
  before every restore write; secrets stay 0600 (bundle
  parts inherit sidecar perms; manifest too).
- Ask first: auth-config inclusion (CAND-038 scope);
  raw-crontab replay; cross-panel bundle import.
- Never: execute part contents; auto-restore without the
  danger dialog; drop the manifest on partial failure
  (parts stay visible).

## 8. Success Criteria

- [ ] Server build green; inject suite green.
- [ ] Smoke bundle checks green live (configs/crons path).
- [ ] Backup page wired; CAND-035 closed (minus auth
  include → 038).
- [ ] Existing 5 backup endpoints + cron/db behavior
  diff-empty (additive only).

## 9. Open Questions

- Bundle retention vs auto-prune (mockup card): still needs
  the retention design (noted since wave 6, still out).
- Cross-panel import (upload a foreign manifest): out —
  own-panel bundles only in wave.

## 10. Decisions (locked 2026-10-13, human Q&A)

- Manifest + parts (per-part reuse over mega-archive).
- DBs: enumerate-all default AND UI checklist (both).
- Configs: sites+db+settings+proxy, NO auth (038 later,
  planned carefully).
- Restore: per-part reuse AND full restore-all behind a
  danger alert.

## 11. Parity mapping (mockup → endpoint)

| Mockup element | Source after wave |
|---|---|
| Full System Snapshot card | bundles card + dialog (DB checklist, toggles) |
| All databases, crons & configs | enumerate + export + stage (auth excluded → 038) |
| Per-part SHA256 lines | sidecars reused (verify buttons work on parts) |
| Auto-prune card | OUT (retention design still needed) |
