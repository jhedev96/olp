# SPEC — watchdog

> Module id: `watchdog` (part of `@olp/server`: site liveness polling).
> Owner: TBD. Status: DRAFT.
> Depends on: sites runtime (locked, liveness source), notify seam (locked).
> Gate: approve before the last backend piece lands.

## 1. Objective

Port the Terwo site health check (`terwo/panel.js:1389-1406`: per-minute
`GET http://127.0.0.1:<port>/` per running site, Telegram on down/recover
transitions only) to an injectable watchdog with zero network in tests,
closing the backend surface completely.

Success: DOWN/recovered fire exactly on transitions; stopped sites never
notify; probe failures never crash the loop; the 60 s lifecycle stays
server-owned.

## 2. API Contract (TypeScript)

```ts
// apps/server/src/watchdog.ts
export interface WatchedSite { id: string; name: string; port: number; running: boolean }
export interface WatchdogProbe {
  /** Resolves when the site answers, rejects on timeout/refusal (5 s). */
  check(port: number): Promise<void>;
}
export interface WatchdogOptions {
  sites: () => WatchedSite[];
  probe: WatchdogProbe;
  notify: (text: string) => void;
}
export interface Watchdog { checkOnce(): Promise<void>; readonly downCount: number }
export function createWatchdog(opts: WatchdogOptions): Watchdog;
export function nodeProbe(timeoutMs?: number): WatchdogProbe; // node:http production probe
```

### Behavior

- Transition-only notifications (Terwo parity): per-site state starts
  unknown (=up). Error after up/unknown → `Website "<name>" DOWN (port
  <port>)`, mark down. Success after down → `… recovered (port <port>)`,
  mark up. Repeated same-state results notify nothing.
- Non-running sites are dropped from state silently (stopping a site never
  notifies — Terwo parity).
- `checkOnce` never rejects: per-site probe failures are consumed as DOWN
  signals; unexpected errors are swallowed per site (the server interval
  additionally logs, belt and suspenders).
- Probe: `GET http://127.0.0.1:<port>/`, 5 s timeout (destroy on timeout),
  body resumed/discarded. Any error or timeout counts as DOWN.
- Lifecycle (server-owned, `index.ts`): 60 s `setInterval(...).unref()`,
  started in `main()` after listen; tests drive `checkOnce()` directly and
  never start the interval.

## 3. Commands

```bash
Build: npm run build --workspace=@olp/server
Test:  npm run test --workspace=@olp/server
```

## 4. Project Structure

```text
apps/server/src/watchdog.ts
apps/server/test/watchdog.test.ts  # scripted probe (no network)
```

## 5. Code Style

```ts
// Good: state keyed by site id, transitions explicit.
if (wasDown) notify(`Website "${site.name}" recovered (port ${site.port})`);
down.delete(site.id);
```

- JSDoc on all exports (English); `node:http` only inside `nodeProbe`.

## 6. Testing Strategy

- Framework: Vitest. Scripted probe (per-port result queue), static site
  lists, recorded notifications.
- Cases: first-error notifies DOWN; repeated error silent; recovery
  notifies once; flapping (down→up→down) notifies each transition;
  stopped sites drop state without notify (restart-then-error notifies
  fresh); probe throw (not just DOWN-result) still resolves `checkOnce`;
  `downCount` tracks; unknown-site success notifies nothing.
- Coverage: all transition branches.

## 7. Boundaries

- Always: transitions only; never notify for stopped sites; never throw
  from `checkOnce`.
- Ask first: changing cadence/timeout; adding latency metrics; per-site
  notify toggles.
- Never: block shutdown on the interval (unrefed); leak site entries for
  deleted sites (dropped when not running — registry removal surfaces as
  not-running via the shared store).

## 8. Success Criteria

- [ ] Transition matrix green with zero network in tests.
- [ ] Live smoke: real site killed/restarted → DOWN then recovered via
  notifier spy (local, no Telegram needed).
- [ ] Backend 100% complete: every Terwo behavior has an OLP counterpart
  (audit extended).

## 9. Open Questions

- None open for v1 port.

## 10. Decisions

- Polling stays in-process (no sidecar); cadence 60 s fixed for v2.0.

## 11. Parity mapping (§9.2)

| Terwo (`panel.js:line`) | OLP | Mark |
|---|---|---|
| `siteHealth` map + transition logic `:1390-1404` | internal map, same transitions | parity |
| `http.get 127.0.0.1:port/, 5 s` `:1394-1399` | `nodeProbe` same | parity |
| stopped-site cleanup (no notify) `:1393` | same | parity |
| 60 s interval + log-on-error `:1406` | server lifecycle same | parity |
| `sendTelegram` DOWN/recovered texts | notify seam same texts | parity |
