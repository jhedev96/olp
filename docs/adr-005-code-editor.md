# ADR-005: Code Editor and Preview Stack (CodeMirror + lowlight)

- Status: Accepted
- Date: 2026-10-11
- Approved: 2026-10-11 (human)
- Scope: Which dependencies render code in the file manager, and how.

## Context

The file-manager mockup shows a highlighted editor with line numbers;
the app shipped a plain `<textarea>` (P3) with zero highlighting. Two
finalists were spiked (both verified in jsdom before adoption):

- CodeMirror 6 (`@codemirror/view` 6.43.14 + state/commands/language +
  per-language packages): ESM, `sideEffects: false`, framework-agnostic
  (no React peer — React 19 safe via `ref`, no wrapper dependency).
  Renders and edits in jsdom (`.cm-editor` present, content readable).
- lowlight 3.3.0 (preview): pure ESM, 59 KB, outputs HAST which
  `hast-util-to-jsx-runtime` turns into real React elements — verified
  (`span.hljs-keyword` in the DOM, `getByText` works).
- highlight.js (rejected): CJS-first 5.5 MB tree whose output is HTML
  strings — rendering it needs `innerHTML`, banned by spec §5. lowlight
  reuses its grammars but never its HTML serializer.

## Decision

1. **Edit mode = CodeMirror 6**, assembled manually (line numbers,
   active line, bracket match, history, default keymap) — the
   `codemirror` meta-package is NOT installed (it would drag every
   language). Per-language packages only (js/ts, json, python, css,
   html, markdown, yaml, sql, php); shell scripts and unknown types
   edit as plain text.
2. **Preview mode = lowlight** (read-only): highlighted `<pre>` via
   HAST→JSX, never `innerHTML`. Unknown grammars and highlight
   failures fall back to plain text (never a blank panel, never an
   error to the user).
3. **Theme is ours**: a minimal `EditorView.theme` in OLP tokens plus
   one bundled hljs dark stylesheet (local file, offline-safe) — no
   theme packages.
4. **The `<textarea>` editor is retired**, not kept as a fallback:
   one editor path, tested through a `viewRef` seam (production code
   never touches it).

## Consequences

- Two highlight engines is deliberate: editing needs a view model,
  preview needs a pure render. Neither crosses into the other's job.
- New-phrase rule for later: any new grammar is one line in
  `components/code/languages.ts` plus its npm package — never a second
  highlighter.
- If CodeMirror ever breaks jsdom rendering, the `viewRef` seam keeps
  save/discard flows drivable without DOM internals.
