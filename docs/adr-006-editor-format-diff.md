# ADR-006 — Editor Prettify Formatter and Diff Engine

> Status: accepted 2026-10-12 (wave 10 design gate).
> Context: CAND-033 (editor Prettify + Diff). Rule: new dependencies
> need an evidence spike + ADR (Recharts/CM6/lowlight precedent).

## Spike evidence (2026-10-12, `npm view`)

- `prettier@3.9.10`: `dist.unpackedSize ≈ 10 MB` (full package with
  every parser). Vite bundles only the imported `prettier/standalone`
  core plus the explicitly imported parser plugins — the panel serves
  its own dist over LAN/localhost, so a low-single-digit-MB editor
  chunk is acceptable (no CDN, no mobile-data story).
- `diff` (jsdiff) `@9.0.0`: `≈ 600 KB` unpacked, zero dependencies.
  Adequate but unnecessary: the wave needs line-level unsaved-change
  review only (no merge, no char-level), which a trimmed LCS covers
  in ~60 lines with zero bundle cost and zero supply-chain surface.

## Decision

1. **Prettier standalone** (`prettier/standalone` + per-parser
   plugins) for `js/jsx/mjs/cjs/ts/tsx/json/css/html/htm/xml/svg/md/
   yml/yaml` (its core set). `php/py/sql/sh/plaintext` stay honestly
   unsupported (button disabled with reason).
2. **Hand-rolled LCS line diff** with common prefix/suffix trim and a
   line-count cap (no `diff` dependency).

## Rejected

- Community formatter plugins (`@prettier/plugin-php`, Python
  ports): uneven quality, extra bundle weight, per-language evidence
  burden — revisit only with real PHP/Python editing demand.
- Server-side formatting (`prettierd`, exec binaries): no backend in
  scope; the editor is client-side by design.
- Naive hand-rolled indenters: poor quality, syntax-unaware —
  worse than an honest unsupported state.
- `diff` package: fine software, but line-level review does not need
  it; zero-dep wins for a security-sensitive admin panel.
- Char-level intra-line highlighting: nice-to-have, out of wave.

## Consequences

- `apps/web/package.json` gains `prettier` (exact minor pinned at
  implementation; lockfile updated).
- Parser mapping lives in `lib/format-code.ts` (extension → parser
  + plugins); unsupported extensions return `null` (UI disables).
- `format()` in prettier v3 is async — callers await it; syntax
  errors reject (UI keeps content + inline error, never partial).
