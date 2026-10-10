# SPEC — proxy

> Module id: `proxy` (part of `@olp/server`: nginx reverse-proxy GUI + routes).
> Owner: TBD. Status: DRAFT.
> Depends on: auth gate (locked), shared `exec` (locked).
> Gate: approve before nginx routes are ported.

## 1. Objective

Port the Terwo Nginx reverse-proxy GUI (`terwo/panel.js:1060-1167`: proxy
registry, conf generation, `nginx.conf` include patching, `nginx -t` gate,
service control) to typed Fastify handlers with an injectable shell/exec
seam, adding exactly one deliberate extension: the system `nginx.conf`
path resolves per environment (Termux `$PREFIX` vs `/etc/nginx`
elsewhere) instead of assuming Termux.

Success: proxy CRUD + service control behave per table; a bad generated
conf never strands the registry (rollback on `nginx -t` failure, Terwo
parity); no `child_process` in route code.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/proxy.ts
export interface Proxy { id: string; name: string; listenPort: number; domain: string; targetPort: number; created: number }
export interface ProxyStore { list(): Proxy[]; save(proxies: Proxy[]): void } // nginx.json (0600) in prod, memory in tests
export interface ProxySystem {
  exec(cmd: string, timeoutMs: number): Promise<string>; // shell (defaultExec compatible)
  readFile(path: string): string | null;                 // nginx.conf read (null when missing)
  writeFile(path: string, data: string): void;
  mkdirp(dir: string): void;
  listDir(dir: string): string[];
  removeFile(path: string): void;
  nginxConfPath(prefix: string): string; // '<prefix>/etc/nginx/nginx.conf' (prefix '' → '/etc/nginx/nginx.conf')
}
export interface ProxyOptions { dataDir: string; sitesDir: string; prefix: string; store: ProxyStore; sys: ProxySystem }
export function nginxConfBlock(proxy: Pick<Proxy, 'listenPort' | 'domain' | 'targetPort'>): string;
export function registerProxyRoutes(app: FastifyInstance, opts: ProxyOptions): void;
```

### Endpoints (all behind the session gate)

| Method + path | Body | Rules | Success |
|---|---|---|---|
| `GET /api/nginx/status` | — | `pgrep -x nginx` probe | `{running}` |
| `POST /api/nginx/service` | `{action: 'start'\|'stop'\|'reload'}` | 1 MB JSON; `start`/`reload` require `nginx` bin (Store hint); `start` failure surfaces tail; `reload` runs `nginx -t` gate first (15 s); unknown action 400 | `{ok:true}` |
| `GET /api/nginx/proxies` | — | — | `{proxies}` |
| `POST /api/nginx/proxies` | `{name, listenPort, domain, targetPort}` | 1 MB JSON; name required; listen 1024–65535 + collision guard; target 1–65535; optional domain charset `a-zA-Z0-9.*_-`; write-all + `nginx -t`, rollback registry on failure; best-effort reload | `{ok:true, proxy}` (`id` 8 hex chars) |
| `DELETE /api/nginx/proxies/:id` | — | unknown id still rewrites conf + reloads (idempotent, Terwo parity: filter-then-write, no 404) | `{ok:true}` |

### Behavior

- Conf block (byte-shape parity `panel.js:1073-1083`): `server { listen <lp>; server_name <domain\|_>; location / { proxy_pass http://127.0.0.1:<tp>; proxy_set_header Host $host; X-Real-IP; X-Forwarded-For } }`.
- `writeAll`: `mkdirp(sitesDir)`; remove `panel-*.conf` stragglers; write one `panel-<id>.conf` per proxy; patch `nginx.conf` with `include <sitesDir>/*.conf;` inside the `http {}` block (brace-matched, Terwo parity) unless already present; run `nginx -t` and throw its tail (last 500 chars) on failure. Missing `nginx.conf` → throw `nginx.conf not found…` (message keeps the Store hint); unbalanced braces → throw `nginx.conf damaged (unbalanced braces)` (legacy Indonesian translated).
- Include-line patching is a pure function of file text (unit-tested without fs): `patchNginxInclude(confText, sitesDir)` exported for tests (throws on missing `http {` / unbalanced braces, no-op when already included).
- Service: `start` = bin gate then `nginx` (10 s, tail-500 on failure); `stop` = `nginx -s stop` (10 s, tail-500); `reload` = bin gate + `nginx -t` (15 s) then `nginx -s reload` (fire-and-forget result, Terwo parity).
- Post-write reload is best-effort everywhere (`nginx -s reload` result ignored — nginx may simply not be running, Terwo parity `nginxTryReload`).
- Registry persists to `nginx.json` (mode `0600`) on create/delete/rollback.
- `prefix` comes from `env-core` detection (`Environment.prefix`); empty prefix yields the system `/etc/nginx` path. No `process.env.PREFIX` reads in this module (server passes it in).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
apps/server/src/proxy.ts        # block gen, include patch, write-all, service + route registration
apps/server/test/proxy-routes.test.ts  # inject() + fake store/sys (no nginx, no fs)
```

## 5. Code Style

```ts
// Good: fs/exec injected, paths parameterized, no PREFIX reads.
export function nginxConfPath(prefix: string): string {
  return `${prefix === '' ? '/etc' : `${prefix}/etc`}/nginx/nginx.conf`;
}
```

- `unknown` bodies narrowed per field; JSDoc on all exports (English).

## 6. Testing Strategy

- Framework: Vitest, Fastify `inject()`, fake `ProxyStore` + in-memory `ProxySystem` (Map-backed fs, scripted exec results), tempdir-free.
- Cases: status true/false via `pgrep` result; service start/stop/reload command shapes + bin-gate hint + unknown action 400 + start-failure tail; create validation matrix (name/port/domain/collision) + conf content exact-match + include patch inserted once (idempotent re-create) + rollback removes registry entry on `nginx -t` failure; delete unknown id still 200 + rewrites; `patchNginxInclude` unit matrix (already-included, missing http block, unbalanced braces); gate 401 on one route.
- Coverage: all validation + rollback branches.

## 7. Boundaries

- Always: `nginx -t` before considering a write successful; rollback registry on gate failure; quote nothing — conf values are validated (ports numeric, domain charset).
- Ask first: supporting non-nginx proxies (Caddy — post-v2.0); managing the main `nginx.conf` beyond the include line.
- Never: write outside `sitesDir` + the single include line; run nginx with unsanitized input; require root (ports <1024 stay rejected).

## 8. Success Criteria

- [ ] All five behaviors per table with zero nginx/fs in tests.
- [ ] Live smoke on Linux: real `nginx -t` passes with a generated conf; reload tolerated while stopped.
- [ ] Needs on-device verification: Termux `$PREFIX/etc/nginx` path (ADR-003).

## 9. Open Questions

- None open for v1 port.

## 10. Decisions

- `nginxConfPath('')` → `/etc/nginx/nginx.conf` (decided in this spec: the single per-OS extension over Terwo).
