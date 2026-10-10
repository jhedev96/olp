# AGENTS — OpenLocalPanel (OLP)

> Agent roster and operating contract. All agents obey `PROJECT_RULES.md`.
> English in all artifacts. One task = one local commit.

## 1. Roles

| Agent | Responsibility | Owns | Must not |
|---|---|---|---|
| `planner` | PRD/PLAN/TASKS/SPECS decomposition, gates, capability maps | `.opencode/plan/**` | Write `apps/*` or `packages/*` implementation |
| `researcher` | Phase 0 ADRs, OS catalog, Node baseline evidence | `docs/adr-*.md`, `docs/os-catalog-draft.md` | Decide scope; only recommends with sources |
| `backend` | Fastify routes + `packages/*` logic, Vitest contract tests | `apps/server/**`, `packages/**` | Touch `apps/web` styling beyond data wiring |
| `frontend` | Vite SPA pages/components, Tailwind, xterm wiring | `apps/web/**` | Add API routes or change contracts unilaterally |
| `reviewer` | Multi-axis review before merge (correctness, security, scope, tests) | Review comments, gate sign-off | Push implementation on the same task it reviews |
| `release` | Installers, CLI packaging, changelog, migration tool | `cli/`, `installers/`, `docs/` release notes | Ship with red gate |

Default assignee: `planner` for plan files, `backend`/`frontend` for implementation, `reviewer` before every phase gate.

## 2. Task Protocol

1. Pick exactly one task from `TASKS/` (mark `[~]` in `TODOS.md` in the same commit only if the task file owns it — otherwise leave tracking to the task commit).
2. Read its spec (`SPECS/spec-<id>.md`) + listed files. State assumptions up front if any.
3. Implement minimal diff (<= ~5 files). Run `npm run build`, scoped `vitest run`, `eslint --max-warnings=0`.
4. Commit with Conventional Commit English message, e.g. `feat(env-core): add alpine detection`.
5. Stop. Report: commit hash, acceptance status, verify output, open questions. Never roll into the next task unasked.

## 3. Question Protocol

- Ambiguous, multi-solution, or human-judgment call -> ask via Open Questions format (assumptions, options with `(Recommended)` first, what is blocked).
- Record resolved decisions in the spec `Decisions` section with date; reference commit.

## 4. Evidence Rules

- Verify against local files (`read`/`grep`/exec) before claiming. Quote `path:line` for code references.
- Never delete/skip failing tests to reach green without human approval in the task.
- Never commit secrets, user config (`~/.olp/*.json`), or unrelated refactors.

## 5. Current Assignment (Phase 0)

- `planner`: done (PRD/PLAN/RULES/TODOS/TASKS/spec-env-core/AGENTS skeletons).
- Next: `researcher` runs T00-02/T00-03/T00-04; `planner` reviews ADRs; `backend` starts Phase 1 only after M1 gate approval.
