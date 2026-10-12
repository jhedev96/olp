# SPEC — editor prettify + diff wave 10 (client-side, no backend)

> Modules: `apps/web` only (`lib/format-code.ts`, `lib/line-diff.ts`,
> `pages/files.tsx` + tests). No backend, no new API, no smoke.
> Owner: TBD. Status: DRAFT (locked 2026-10-12, human Q&A + ADR-006).
> Depends on: editor tabs with `original` snapshot (shipped),
> controlled `CodeEditor` (`value` syncs via dispatch).
> Gate: approve before W10-01 (first code).

## 1. Objective

Close CAND-033: a Prettify button (Prettier core set, honest
unsupported otherwise) and a Diff toggle (unified inline panel of
unsaved changes vs the opened snapshot) in the editor toolbar,
next to Discard/Save (mockup toolbar parity).

Success: a messy JS file prettifies in place; a syntax error keeps
content with an inline message; the diff panel shows exactly the
unsaved hunks; php files show a disabled Prettify with reason;
web suite green; no backend file touched.

## 2. API Contract (TypeScript)

```ts
// apps/web/src/lib/format-code.ts (new)
export interface FormatPlan { parser: string } // plugins load lazily per parser (separate Vite chunks)
export function formatPlanFor(name: string): FormatPlan | null; // null = unsupported
export function unsupportedReason(name: string): string | null;
export async function formatCode(name: string, content: string): Promise<string>;
 // resolves formatted; rejects Error (syntax) or 'unsupported ...' (no plan)

// apps/web/src/lib/line-diff.ts (new)
export type DiffLine =
  | { type: 'context'; text: string; aLine: number; bLine: number }
  | { type: 'del'; text: string; aLine: number }
  | { type: 'add'; text: string; bLine: number };
export interface DiffHunk { header: string; lines: DiffLine[] } // header `@@ -a,b +c,d @@`
export const DIFF_MAX_LINES = 10000;
export function diffLines(a: string, b: string, context?: number): DiffHunk[]; // [] when identical
 // throws Error('diff too large ...') past the cap (UI shows the message, not a hang)

// files.tsx toolbar: [Save][Prettify][Diff toggle][Discard][Close]
// diff panel (collapsible, under the toolbar): hunks or `No unsaved changes.`
```

### Behavior

- Parser map (provisional, proven at build): babel ←
  js/jsx/mjs/cjs (+json), typescript ← ts/tsx, css ← css,
  html ← html/htm/xml/svg, markdown ← md, yaml ← yml/yaml.
  Everything else → `null` (php/py/sql/sh/plain).
- Prettify: `await formatCode(tab.name, tab.content)` → `setTabs`
  content (controlled editor syncs) + clears `editorError`; reject
  → `editorError = 'Prettify failed: <first line of message>'`
  (capped 200 chars), content untouched. Busy state disables the
  button (`Prettifying…`) — no double-tap races.
- Diff toggle: per-page boolean (not per-tab — one panel showing
  the ACTIVE tab); recompute memoized on `[original, content]`;
  identical → `No unsaved changes.`; over-cap → cap message.
  Colors: del red, add green, hunk header mono muted, line numbers
  both sides where present.
- Prettify on unsupported: button `disabled` + `title` reason
  (`Prettier has no <ext> parser here`); no dead clicks.
- No `dangerouslySetInnerHTML` anywhere (JSX text nodes only —
  diff lines render as text, XSS-safe by construction).

## 3. Commands

```bash
Build: npm run build --workspace=@olp/web   # proves prettier imports resolve; note dist delta
Test:  npm run test --workspace=@olp/web
Type:  npm run typecheck --workspace=@olp/web
```

## 4. Project Structure

```text
apps/web/src/lib/format-code.ts             # parser map + formatCode (W10-01)
apps/web/src/lib/line-diff.ts               # LCS + hunks + cap (W10-01)
apps/web/test/format-code.test.ts           # real prettier: js/json/md ok, php null, syntax reject (W10-01)
apps/web/test/line-diff.test.ts             # add/del/change/context/identical/cap (W10-01)
apps/web/src/pages/files.tsx                # toolbar + panel wiring (W10-02)
apps/web/test/files.test.tsx                # + cases (extends file)
apps/web/package.json                       # + prettier (W10-01, lockfile)
docs/adr-006-editor-format-diff.md          # decision record (this wave planning)
```

## 5. Code Style

- Parser/plugin table data-driven (extension → `{parser, plugins}`),
  not a switch sprawl; unknown extensions fall through to `null`.
- LCS: prefix/suffix trim first, DP (`Int32Array` rows) on the
  changed middle only; hunk assembly with configurable context
  (default 3).
- No `any`; English JSDoc + comments.

## 6. Testing Strategy

- format-code (real prettier, no mocks): messy JS formats to
  canonical; JSON sorts nothing but normalizes; md heading spacing;
  `formatPlanFor('x.php')` null + reason names ext; syntax error
  rejects with location; unsupported `formatCode` rejects (never
  resolves garbage).
- line-diff (pure): pure-add / pure-del / change / context
  windowing / identical → [] / empty-vs-content / cap throw with
  message; hunk header arithmetic spot-checked.
- files page: Prettify applies formatted text to the tab (CM
  `viewRef` seam like save/discard tests); failure keeps text +
  inline error; Diff toggle shows hunks then `No unsaved changes.`
  after Discard; php tab shows disabled Prettify.
- No smoke (no backend surface); verification is build +
  typecheck + web suite.

## 7. Boundaries

- Always: client-side only (no file content leaves the browser
  beyond existing read/write); content never half-written.
- Ask first: adding a language (plugin weight + evidence);
  char-level highlighting; raising the diff cap.
- Never: new runtime dep without ADR (this wave's ADR-006 covers
  prettier only); `innerHTML` for diff lines; auto-prettify on
  save (explicit button only — no surprise rewrites).

## 8. Success Criteria

- [ ] Web build green (prettier imports resolve; dist delta noted
  in the W10-01 commit message).
- [ ] Web suite green (incl. real-prettier + LCS cases).
- [ ] Toolbar matches mockup order signals (Prettify/Diff beside
  Discard/Save); CAND-033 closed.
- [ ] No `apps/server` or `packages/*` file in the diff.

## 9. Open Questions

- Prettier minor pinning policy (renovate-style bumps?): out of
  wave — pinned at implementation, revisited with other deps.
- Char-level intra-line diff: future polish, not this wave.

## 10. Decisions (locked 2026-10-12, human Q&A + spike)

- Prettier core set only (php/py/sql/sh disabled honestly).
- Inline unified diff panel (mobile-friendly, no side-by-side).
- Failure = inline error + untouched content (no dialog).
- `diff` package rejected (600 KB for line review unneeded);
  hand-rolled trimmed LCS per ADR-006.

## 11. Parity mapping (mockup → source)

| Mockup element | Source after wave |
|---|---|
| Prettify button | `formatCode` + toolbar (core set; disabled+reason otherwise) |
| Diff button | `diffLines` + inline panel vs `original` snapshot |
| Discard / Save | existing (untouched; Discard clears the diff to empty) |
| Line-number gutter | existing CM gutter (untouched) |
