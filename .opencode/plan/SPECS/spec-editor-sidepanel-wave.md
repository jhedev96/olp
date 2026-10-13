# SPEC — editor side-panel parity wave 18 (CAND-040)

> Modules: `web` (`pages/files.tsx`, maybe
> `components/code/*`) only. No new dep. Owner: TBD.
> Status: DRAFT (deviation found 2026-10-13 on human test-drive).
> Depends on: Phase 10 editor + wave 10 prettify/diff (behavior
> reused, layout only).
> Gate: approve before W18-01 (first code).

## 1. Objective

Close CAND-040: the file-manager code editor and previewer become
side panels next to the file list, like mockup
`terwo_file_manager_code_editor` — file list left, tabbed editor
right (tabs on top, toolbar Prettify/Diff/Discard/Save kept),
instead of today's fullscreen modals (`files.tsx:617` editor,
`files.tsx:763` preview). No behavior change: same tabs, same
CM6/lowlight components, same endpoints.

Success: clicking Edit opens a right-side tabbed editor panel
with the list still visible; multiple files stack as tabs;
preview opens beside the list too; modal overlays gone from this
flow; suites green; mockup-wins rule restored with the deviation
recorded below.

## 2. API Contract (TypeScript)

```ts
// No endpoint change (editor stays client-side, preview reuses
// POST /api/read + image bytes like today).
// State shape stays: EditorTab[] + activeTab + preview { name, kind, content? }.
// Layout only: panels render inline (grid/flex) instead of `fixed inset-0`.
```

### Behavior

- Files page becomes a two-column layout when a panel is open:
  list card left, editor/previewer right; list collapses back to
  full width when all tabs closed and no preview.
- Editor panel keeps: tab row (name + close, active highlight),
  CM6 `CodeEditor`, toolbar (Save, Prettify, Diff toggle, Discard,
  Close), inline error + unified diff panel (wave-10 behavior
  untouched).
- Preview panel keeps: image + code (`CodePreview`) content,
  Close; restores beside-the-list instead of overlay.
- Editor and preview are mutually exclusive on the right side
  (opening one replaces the other — matches today's one-focus
  flow; recorded decision, revisit if mockup proves otherwise).
- Mobile (`≤md`): panels stack below the list (bottom-bar nav
  owns the screen; no side-by-side on narrow viewports).
- Keyboard: `Ctrl+S` saves (existing), `Esc` closes the panel.

## 3. Commands

```bash
Build: npm run build --workspace=@olp/web
Test:  npx vitest run test/files.test.tsx (+ new side-panel cases)
```

## 4. Project Structure

```text
apps/web/src/pages/files.tsx            # modal -> side panels (W18-01)
apps/web/test/files.test.tsx            # + cases: panel beside list, tabs stack, Esc (W18-01)
.opencode/plan/INVENTORY_WEB.md         # files row notes side-panel parity (W18-02)
```

## 5. Code Style

- Reuse `CodeEditor`/`CodePreview` as-is (no component changes
  unless the layout forces it; justify in the task if so).
- No `any`; English JSDoc; keep the file under ~400 LOC per
  module rule or record justification (files.tsx is already big —
  prefer extracting a `components/code/EditorPanel.tsx` if the
  diff exceeds ~150 lines).

## 6. Testing Strategy

- Edit click renders the panel inline (no `fixed inset-0`
  overlay) with the list still in the document.
- Two files stack two tabs; close returns full-width list.
- Preview renders beside the list; Close restores width.
- Existing editor cases (save/prettify/diff/discard/unsaved
  guard) pass unchanged — behavior diff-empty by assertion.
- Mobile viewport: panel stacks (jsdom width stub or class
  assertion per existing responsive-test pattern).

## 7. Boundaries

- Always: mockup wins on layout (this wave exists because the
  modal deviated silently — record, don't repeat).
- Ask first: editor AND preview visible at once (spec says
  exclusive); resizable split; preview-while-editing live sync.
- Never: change editor/preview behavior or endpoints in this
  wave (layout only); add deps; regress narrow-viewport nav.

## 8. Success Criteria

- [ ] Web build green; files suite green.
- [ ] Human test-drive confirms side-by-side on desktop.
- [ ] INVENTORY_WEB files row records side-panel parity;
  CAND-040 closed.

## 9. Open Questions

- Mockup split orientation (vertical_split icon suggests
  left/right code panes, not list/editor): confirm list-left /
  editor-right from the mockup screenshot before W18-01.

## 10. Decisions (locked 2026-10-13, human report)

- Modal → side panels (mockup wins; deviation was unrecorded).
- Editor + preview mutually exclusive on the right (revisit on
  evidence).
- Stack below list on mobile.

## 11. Parity mapping (mockup → page)

| Mockup element | Source after wave |
|---|---|
| File list + right tabbed editor (tabs, toolbar) | `files.tsx` side panel (same components, inline layout) |
| Preview beside list | preview panel (same content, inline layout) |
| Prettify/Diff/Discard/Save toolbar | unchanged behavior, moved with the panel |
