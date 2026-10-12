# SPEC — terminal snippets wave 11 (macros row, client-side)

> Modules: `apps/web` only (`lib/snippets.ts`, `pages/terminal.tsx`
> + tests). No backend, no new API, no smoke. Owner: TBD.
> Status: DRAFT (locked 2026-10-12, human Q&A).
> Depends on: `sendKey` + ConfirmDialog (both shipped).
> Gate: approve before W11-01 (first code).

## 1. Objective

Close CAND-034: a macros row (6 mockup presets + user custom
snippets, one-tap send) with a destructive-confirm guard and an
inline add/delete UI, all client-side in localStorage.

Success: tapping a preset sends `cmd\n` over the existing WS path;
`killall node` asks first; a custom snippet survives reload;
web suite green; no backend file touched.

## 2. API Contract (TypeScript)

```ts
// apps/web/src/lib/snippets.ts (new)
export const SNIPPET_KEY = 'olp.snippets.v1';
export const MAX_CUSTOM = 20;
export const MAX_LEN = 500;
export const DEFAULT_SNIPPETS: readonly string[]; // 6, mockup-derived, rebranded
export interface SnippetStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export function loadSnippets(storage?: SnippetStorage): string[]; // corrupt/absent -> []
export function saveSnippets(custom: string[], storage?: SnippetStorage): void; // validated + capped
export function isDestructive(cmd: string): boolean; // best-effort UX guard (NOT a security boundary)

// terminal.tsx: macros row under the exec form:
// [preset…][custom… ×] + inline [input][Add]; destructive taps -> ConfirmDialog -> sendKey(cmd + '\n')
```

### Behavior

- Defaults (mockup union, rebranded): `pkg update`,
  `pkg upgrade`, `pm2 restart olp`, `termux-wake-lock`, `htop`,
  `git status`. (`killall node` stays user-addable; placeholder
  shows it as an example.)
- Send path reuses `sendKey(cmd + '\n')` exactly (focus restore +
  closed-socket drop included — no second implementation).
- Destructive patterns (documented, best-effort): `kill(all)`,
  `restart`, `rm -rf`, `reboot/halt/shutdown`, `mkfs`, shell `dd`,
  `pm2 restart|kill|delete`. Match → ConfirmDialog naming the
  command; confirm sends, cancel drops. The raw exec form stays
  unguarded (guard is accident-prevention, not a sandbox).
- Storage: `localStorage` namespaced key, JSON string array;
  load validates (non-empty strings, ≤500 chars, max 20 —
  extras dropped, corrupt → `[]`); save clamps the same way.
  No `storage` API (SSR/test-absent) → in-memory no-op that never
  throws.
- Inline UI: input (maxLength 500, placeholder with example) +
  Add (ignores empty/duplicates-of-any-row, caps at 20 with an
  inline note); each custom chip carries an `×` (aria-label
  `Remove <cmd>`); presets have no `×`.
- Snippets are local-only (no sync, no server) — documented in
  the section hint.

## 3. Commands

```bash
Build: npm run build --workspace=@olp/web
Test:  npm run test --workspace=@olp/web
Type:  npm run typecheck --workspace=@olp/web
```

## 4. Project Structure

```text
apps/web/src/lib/snippets.ts                  # presets/storage/guard (W11-01)
apps/web/test/snippets.test.ts                # lib matrix (W11-01)
apps/web/src/pages/terminal.tsx               # macros row + dialogs (W11-02)
apps/web/test/terminal.test.tsx               # + cases (extends file)
```

## 5. Code Style

- Pattern table data-driven (`RegExp[]` with comments), not a
  nested-if sprawl; matching is case-insensitive word-boundary.
- No `any`; English JSDoc; caps as named constants.

## 6. Testing Strategy

- lib (jsdom localStorage + memory fakes): defaults exact list;
  round-trip save/load; corrupt JSON → []; over-long/dupes capped;
  destructive matrix (each pattern hits, `htop`/`git status`/
  `echo hi` clean); missing-storage no-throw.
- page (fake socket like existing terminal tests): row renders
  presets + customs; safe tap sends `{t:'in', d:'htop\n'}`;
  destructive tap opens dialog naming the command, cancel sends
  nothing, confirm sends; add/delete flows persist to localStorage;
  cap note at 20.
- No smoke (no backend surface); verification is build +
  typecheck + web suite.

## 7. Boundaries

- Always: same-shell trust (snippets send as the user — no new
  privilege); destructive confirm before send; validated storage
  reads (never `JSON.parse` unguarded).
- Ask first: raising caps; syncing snippets server-side;
  extending the destructive list to interactive binaries.
- Never: new backend for snippets; auto-running anything on
  connect; blocking the exec form.

## 8. Success Criteria

- [ ] Web build + typecheck green.
- [ ] Web suite green (lib matrix + page flows).
- [ ] Macros row matches mockup signals (presets + one-tap);
  CAND-034 closed.
- [ ] No `apps/server` or `packages/*` file in the diff.

## 9. Open Questions

- None (all three scoped by human Q&A 2026-10-12).

## 10. Decisions (locked 2026-10-12, human Q&A)

- Presets (6, rebranded) + custom local (max 20, 500 chars).
- Confirm for destructive patterns (UX guard, not a boundary).
- Inline add/delete (no modal).

## 11. Parity mapping (mockup → source)

| Mockup element | Source after wave |
|---|---|
| Desktop MACROS row | preset chips, one-tap `sendKey` |
| Mobile ONE-TOUCH RUNNERS | same row (flex-wrap covers both; no separate mobile UI) |
| `pm2 restart terwo` | rebranded `pm2 restart olp` (RELOAD_CMD parity) |
| `killall node` preset | user-addable (placeholder example; confirm-guarded) |
