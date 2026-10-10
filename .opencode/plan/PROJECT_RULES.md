# PROJECT RULES — OpenLocalPanel (OLP)

> Living document. Amend by PR with reason. All rules apply to humans and agents.
> Language of this file and all artifacts: English.

## 1. Planning Discipline

1.1. Always decompose work as Plan -> Task -> Spec. No implementation without a spec covering Objective, Commands, Structure, Style, Testing, Boundaries, Success Criteria, Open Questions.
1.2. One request bundling several independently testable capabilities gets a capability map first (module ids, dependency direction, build order) before any module spec.
1.3. Specs live in `SPECS/spec-<module-id>.md` (kebab-case, stable ids, never renamed mid-initiative). Plans in `PLAN.md`, tasks in `TASKS/phase-<nn>-<name>.md`, running checklist in `TODOS.md`.
1.4. Human reviews and approves each gate: Spec -> Plan -> Tasks -> Implement. Do not skip gates.

## 2. Commit Discipline

2.1. One task = one local commit. No batching, no drive-by refactors in the same commit.
2.2. English only. Conventional Commits, imperative subject (<= 72 chars):
  `feat(env-core): add alpine detection from os-release`
  `fix(files): reject path traversal on rename`
  `chore(ci): add alpine smoke job`
  Types: `feat|fix|refactor|test|docs|chore|build|ci`.
2.3. Each commit must build (`npm run build`) and pass its scope tests (`vitest run <scope>`). Failing-test commits are rejected.
2.4. Never commit secrets, `~/.olp/*.json`, or generated Vite/Tailwind output beyond what the build owns. Never rewrite published history.

## 3. Open-Questions Protocol

3.1. Stop and ask when: requirements are ambiguous, two valid solutions exist, human judgment is needed (naming, scope cut, security tradeoff), or evidence contradicts assumptions.
3.2. Format: state assumptions made so far, list options with recommendation first and `(Recommended)` label, and what is blocked until answered.
3.3. Do not guess through ambiguity to reach green. A blocked task with a crisp question beats a merged guess.
3.4. Record resolved questions in the relevant spec (`Decisions` section) with date.

## 4. English-Everywhere Rule

4.1. English in: JSDoc, inline comments, identifiers, commit messages, PR titles/descriptions, documentation, README, PRD, PLAN, TASKS, SPECS, TODOS, ADRs, error messages surfaced to new code.
4.2. Legacy Indonesian strings in ported Terwo code are translated to English at port time (keep legacy mapping table in the spec for review).
4.3. Conversation with the user may be in the user's language; artifacts never are.

## 5. Code & Structure Rules

5.1. TypeScript strict, no `any` without `// SAFETY:` justification. ESLint + Prettier clean.
5.2. No new source file over ~400 LOC without written justification in the task.
5.3. OS-specific logic lives only in `packages/env-core`, `packages/pkgman`, `packages/services`, `packages/sysinfo`. Feature code calls the interface, never `process.platform` directly.
5.4. Preserve Terwo safety semantics when porting: `PANEL_ROOT` jail, name validation, body/row/char caps, `0600` config perms, localhost-by-default bind.
5.5. Offline-first: no runtime CDN. Frontend deps via npm + Vite bundle.

## 6. Testing Rules

6.1. New logic ships with tests. Bug fix ships with a regression test first (red -> green).
6.2. Env detection uses fixture `os-release` files per OS. Path-jail uses traversal cases. Routes use Fastify `inject()` tests.
6.3. Never delete or skip a failing test to reach green without human approval recorded in the task.

## 7. Agent Rules

7.1. Agents state hypotheses and verify against local evidence (`read`/`grep`/exec) before synthesizing. Trust evidence over speculation.
7.2. Agents prefer specialized file tools over shell for edits; verify edited regions before finishing.
7.3. Agents do not expand scope beyond the active task. New needs go to Open Questions or a new task.

## 8. Change Process for These Rules

- Propose additions as: rule text (English) + rationale + example. They take effect once the user approves and this file is committed.
- Candidate future rules (not yet active): coverage threshold, performance budgets per route, ADR requirement for new dependencies.
