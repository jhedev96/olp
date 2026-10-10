# SPEC — files

> Module id: `files` (part of `@olp/server`, not a separate package).
> Owner: TBD. Status: DRAFT.
> Depends on: auth gate (locked). Gate: approve before file-manager routes are ported.

## 1. Objective

Port all 12 Terwo file-manager endpoints (`terwo/panel.js` file-manager section + `apiFileZip/Unzip/Preview`) to typed Fastify handlers with identical paths, limits, and safety semantics, so the file-manager UI works unchanged against OLP.

Success: every Terwo file operation (list through preview) behaves the same against OLP; path traversal is impossible; error shapes stay `{error}` with HTTP 400.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/files.ts
export function safePath(root: string, rel: string): string; // throws outside root
export function safeName(name: unknown): string;             // throws on bad name
export function relOf(root: string, abs: string): string;    // '' for root
export interface FilesOptions { root: string; exec?: ExecFn }
export function registerFilesRoutes(app: FastifyInstance, opts: FilesOptions): void;
```

### Endpoints (all behind the session gate)

| Method + path | Body / query | Limits | Success |
|---|---|---|---|
| `GET /api/files?path=` | dir rel path | — | `{path, entries:[{name,type,size,mtime}]}` dirs-first, name-sorted |
| `POST /api/mkdir` | `{path, name}` | 1 MB JSON | `{ok:true}` (recursive) |
| `POST /api/touch` | `{path, name}` | 1 MB JSON | `{ok:true}` (no clobber: `wx`) |
| `POST /api/rename` | `{path, from, to}` | 1 MB JSON | `{ok:true}` |
| `POST /api/delete` | `{path, name}` | 1 MB JSON | `{ok:true}` (recursive, forced) |
| `POST /api/read` | `{path, name}` | 1 MB JSON; file ≤ 1 MB | `{ok:true, content}` (utf8) |
| `POST /api/write` | `{path, name, content}` | 10 MB JSON; content must be string | `{ok:true}` |
| `POST /api/upload` | `{path, name, data}` base64 | 51 MB JSON; binary ≤ 50 MB | `{ok:true, size}` |
| `GET /api/download?path=&name=` | dir + name | — | octet-stream attachment, `Content-Disposition` with de-quoted filename |
| `POST /api/files/zip` | `{path}` full rel target | 1 MB JSON; refuses root; needs `zip` bin; 60 s timeout | `{ok:true, zipPath}` (`<target>.zip`, `zip -rq`, cwd = dirname) |
| `POST /api/files/unzip` | `{path}` must end `.zip` | 1 MB JSON; needs `unzip` bin; 60 s timeout | `{ok:true}` (`unzip -o`, `-d` dirname) |
| `GET /api/files/preview?path=` | full rel path | image ext whitelist; must be file ≤ 20 MB | streamed bytes with image content-type |

### Behavior

- `safePath(root, rel)`: `resolve(root, rel || '.')`; result must equal `root` or start with `root + sep`, else throw `Access outside working directory denied`. Note: lexical only, symlinks not resolved (Terwo parity, known limitation documented here).
- `safeName(name)`: trim; reject empty/`.`/`..`/any `/` or `\` or NUL → throw `Invalid name`. Single segment only (callers join with the directory).
- `relOf(root, abs)`: `relative(root, abs)`; `''` for root itself.
- List: `readdir` with types; `stat` per entry best-effort (size/mtime `0` on failure); dotfiles included; sort dirs-first then locale name.
- `touch` opens `wx` and ignores `EEXIST` (no clobber, Terwo parity).
- `read`/`write` are utf8 text; `read` rejects files over 1 MB (`File too large to edit (max 1 MB)`).
- `upload` decodes base64 to Buffer, rejects over 50 MB (`File too large (max 50 MB)`).
- `download` stats first (must be file), sets `Content-Length` + attachment disposition, streams (never buffers).
- `zip` refuses `root` itself (`Cannot zip root`); missing bin → 400 `Package "zip" is not installed — install it first via the Store menu` (same for `unzip`).
- `unzip` rejects non-`.zip` targets (`Not a zip file`).
- `preview` whitelist: `.png .jpg .jpeg .gif .webp .svg .ico`; others → 400 `Preview supports images only`; over 20 MB or non-file → 400 `Invalid file`.
- All handler errors surface as HTTP 400 `{error: message}` (Terwo outer-catch parity). Gate violations stay 401 from the auth hook.
- Legacy Indonesian strings translated to English at port time (`Bukan file zip` → `Not a zip file`, `Preview hanya untuk gambar` → `Preview supports images only`).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
apps/server/src/files.ts   # helpers + registerFilesRoutes
apps/server/src/exec.ts    # shared defaultExec + quoteSingle (also used by stats.ts)
apps/server/test/files-routes.test.ts
```

## 5. Code Style

```ts
// Good: helpers pure on (root, rel); routes thin.
const dir = safePath(opts.root, (body.path as string) ?? '');
await fsp.mkdir(join(dir, safeName(body.name)), { recursive: true });
return { ok: true };
```

- `unknown` bodies narrowed per field; `node:fs/promises` for file ops; `node:child_process` only via injected `exec` (zip/unzip tests inject fakes).
- JSDoc on all exports (English).

## 6. Testing Strategy

- Framework: Vitest, Fastify `inject()`, real temp dirs (`mkdtemp`), fake `exec` for zip/unzip (assert exact command strings), real fs otherwise.
- Cases: list sorting + traversal rejection (`..`, absolute escape); mkdir/touch/rename/delete round-trip; touch no-clobber; read/write + 1 MB refusal + non-string content; upload base64 + 50 MB refusal (small synthetic, assert math not bulk); download headers + bytes; zip root refusal + missing-bin message + command shape; unzip non-zip refusal; preview whitelist + oversize + bytes; gate 401 on one route (gate itself covered by auth tests).
- Coverage: all throw paths of `safePath`/`safeName`.

## 7. Boundaries

- Always: jail to `root`; `0600` untouched (files keep default perms — only config is `0600`); stream downloads/previews.
- Ask first: raising any size cap; resolving symlinks (changes jail semantics).
- Never: `rm -rf` outside `safePath`; buffer downloads into memory; shell-interpolate unquoted paths.

## 8. Success Criteria

- [ ] All 12 endpoints behave per table against temp dirs.
- [ ] `grep -rn "process.platform\|PREFIX" apps/server/src/files.ts` empty (no OS branching; bins resolved via `PATH`, missing-bin error preserved).
- [ ] File-manager UI works unmodified against OLP (follow-up verification).

## 9. Open Questions

- None open for v1 port. Caps (`1/10/50/20 MB`) revisit only with human approval.

## 10. Decisions

- None yet.
