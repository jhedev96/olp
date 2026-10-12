# TASKS — Phase 20 editor prettify + diff wave 10 (client-side)

> Spec: `SPECS/spec-editor-wave.md` + ADR-006 (both approved). Scope
> is CAND-033 only; no backend, no smoke. New dep: `prettier`
> (covered by ADR-006 — no other dep in this wave).
> Each task = one local commit; branch `<type>/w10-<topic>` → merge.

- [ ] W10-01: prettier install + `format-code.ts` + `line-diff.ts` +
  ADR-006 + unit tests (real prettier, LCS matrix)
- [ ] W10-02: files toolbar + diff panel wiring + page tests
  (mockup button order, failure/expiry states)
- [ ] W10-03: docs (CHANGELOG, CAND-033 close, INVENTORY_WEB files
  row)

Gate: web build + typecheck + suite green; dist delta noted;
`apps/server` + `packages/*` untouched in the diff.
