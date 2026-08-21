# 07 — Conventions

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

## Language & toolchain

- **TypeScript**, strict. Node 22, ESM (`"type":"module"`). Target `ES2022`, `moduleResolution: "bundler"` (or `nodenext`; pick one repo-wide — record in ADR if you change).
- Package manager: **pnpm workspaces** (`pnpm-workspace.yaml` lists `packages/*`).
- Build: `tsc` per package emitting to `dist/` (or `tsup` if bundling helps the CLI/MCP bins — ADR if added). `@musterd/protocol` is consumed as source-or-dist via workspace `*`.
- Test: vitest. Static gates: **strict `tsc --noEmit`** plus **ESLint** (flat config, `@typescript-eslint` + `import`) and **Prettier** (ADR 013, which supersedes ADR 004's deferral). The "Lint / format rules" below are now machine-enforced: `pnpm lint` (and `pnpm format:check`) must be clean.

## tsconfig (root `tsconfig.base.json`, extended per package)

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
  },
}
```

## Lint / format rules (the ones that matter)

- No `any` without a `// reason:` comment. Prefer `unknown` + narrowing.
- All external input parsed through `@musterd/protocol` zod schemas at the boundary; never trust a raw frame/body/argv.
- No default exports except a package's bin entry. Named exports everywhere.
- Imports ordered: node builtins → external → `@musterd/*` → relative. Prettier handles formatting; don't hand-format.

## Shared values and transforms (the trap that keeps recurring)

Six defects across four subsystems have had one skeleton: **one value or transform, two consumers,
opposite needs — and the second consumer is invisible from the first's call site.** Case law and the
instance table: [ADR 247](../decisions/247-documented-discard-is-a-precondition.md).

- **Before adding a consumer to a shared value, ask both clauses: _what wrote this row, and who else reads it?_**
- **When a helper documents why it throws something away, that discard is a precondition on its consumers, not an implementation note.** Enumerate the callers before adding one. A documented transform is more dangerous than an undocumented one, because the documentation terminates the investigation. Cite ADR 247 at the discard so the next consumer meets the precondition where they are already reading.
- **When a test cites an ADR as its reason, check that the ADR's question is your question.** Purpose does not transfer across consumers.
- **A guard that never instantiates the second consumer's case is decoration** — including a round-trip test whose fixture never populates the field, and a rule whose mutant survives.
- The remedy is **not** to widen the predicate until it satisfies everyone: make each consumer state its own need at its own call site.

## Error handling pattern

- One error type per package surface: server `MusterdError(code: ErrorCode, message)`; CLI `CliError(code, message)`. Both carry a code from the `02-protocol` error-code enum (CLI maps code → exit per `04-cli.md`).
- Throw `MusterdError` at the point of detection; transports catch at the boundary and serialize (`toHttp()` / `toFrame()` / CLI `→ stderr + exit`). Never `console.log` an error and continue.
- Validation errors always reference _what_ failed (field + reason), surfaced from zod's issues.

## Logging format

- Server: structured single-line JSON to stdout: `{ "ts":<ms>, "level":"info|warn|error", "msg":..., "team?":..., "member?":..., "act?":..., "conn?":... }`. One log line per meaningful event (connect, send, deliver, reap, error). No PII beyond member names (which are not secret); **never log tokens**.
- CLI: human output to stdout, errors to stderr; `--json` switches stdout to machine JSON. Debug logs behind `MUSTERD_DEBUG=1` to stderr.

## Commit message format

```
<area>: <imperative summary>      # area ∈ protocol|server|cli|mcp|docs|spec|build|test
                                  # e.g. "server: route team/broadcast envelopes"
<body: what & why, not how>
<footer: "Refs ADR-00N" when a decision/deviation is involved>
```

Each commit keeps **docs and code in agreement** (the living-doc rule). A commit that changes behavior described in a doc must update that doc in the same commit. A commit that deviates from a doc must include/reference the ADR.

## Git workflow (one enforced way — [ADR 106](../decisions/106-unified-git-workflow.md))

There is exactly one way to land a change; GitHub enforces it, so don't improvise a merge method or a
catch-up strategy. The full playbook lives in [`AGENTS.md`](../../AGENTS.md); the essentials:

- **Branch from fresh `origin/main`** in a worktree (`feat/`|`fix/`|`docs/<slug>`), one branch per lane.
- **Squash-merge only** — merge-commit and rebase-merge are disabled; `main` keeps a **linear history**,
  one commit per PR.
- **Open a PR and let it land itself:** `gh pr create …` then `gh pr merge <n> --squash --auto --delete-branch`. Auto-merge waits for the required checks and squash-merges when green — don't poll.
- **Required to merge:** the `gates` CI (`06-testing.md`) green — the single required check (ADR 180 retired `Cursor Bugbot`). The `review` workflow may comment on PRs touching protocol/server, but it is **advisory** and never blocks. `main` is PR-only, no direct pushes, no force-push/deletion. Admin (owner) is break-glass.
- **Sync a stale branch by rebase, never `merge main`:** `git fetch origin main && git rebase origin/main`, resolve once, `git push --force-with-lease`. Branch history is throwaway under squash; never `git push --force`.
- **Before pushing**, run the fast local smoke (`pnpm typecheck && pnpm format:check`) — an optimization for feedback, not a duplicate of CI, which is the authority.

## ADRs (`docs/decisions/NNN-<slug>.md`)

Sequential, never renumbered.

**Amending an accepted ADR — two ways to trip `change-adr:check`, both hit live on 2026-08-01.**
The gate refuses any edit to an **accepted** ADR's `## Decision`, and it is right to: a frozen
decision is the record of what was decided, not a place to record what happened next.

- **Put follow-up notes in `## Consequences`, never in `## Decision`.** A dated "completed / scope
  limit / superseded by" note belongs there — it constrains how the Decision is read without
  rewriting it.
- **Prettier cannot reach `docs/`, and you no longer have to remember that** (ADR 284). `pnpm format`
  and `pnpm format:check` both read one list — `FORMAT_GLOBS` in `scripts/format-scope.ts` — so the
  writer's scope and the gate's scope are equal by construction; `.prettierignore` carries `docs/`
  as a backstop for invocations that list cannot see (a bare `npx prettier --write .`, format-on-save).
  Until 2026-08-19 this was discipline only, and `pnpm format` rewrote **214 files** no gate checked.
  The reason the exclusion stands: `prettier --write` on an ADR will restyle a frozen section
  (`*x*` → `_x_`), and a reflow rewrites `git blame` for arguments nobody was editing.

Template:

```md
# NNN — <title>

- Status: accepted
- Date: YYYY-MM-DD

## Context

## Problem

## Decision

## Consequences

## Observability & Evaluation # required for agent-facing features; "n/a — <reason>" otherwise (ADR 052)
```

The **Observability & Evaluation** section (ADR 052) answers, for any agent-facing feature: **Traces** —
what spans/coordination acts + agent-turn detail it emits ([ADR 194](../decisions/194-flywheel-practice-not-batond.md)); **Eval** — its success metric, the
dataset, and the **baseline** to compare against; **Experiment** — what would validate it (may be "none
yet", but named). The `obs-evals:check` guard (`scripts/check-obs-evals.ts`, modeled on
`check-arch-trees.ts`) enforces presence and shape, not content, and **is wired into `format:check`**
(prettier + `roadmap:check` + `arch-trees:check` + `obs-evals:check`). It enforces from **ADR 060 onward**;
ADRs 001–059 predate the gate and are grandfathered (this DoD clause still asks every agent-facing change
for the section regardless of number).

Known ADRs to write while implementing (because the docs already flagged simplifications): **001 — members table folds memberships** (`01-data-model.md`), plus any dep additions (`hono`, `cac`/`mri`, `tsup`) and any protocol-schema change.

## Definition of done (per task)

A task/milestone is done only when **all** are true:

1. Code compiles (`pnpm -r build`) with no TS errors.
2. Strict typecheck clean (`pnpm -r exec tsc --noEmit`); `pnpm lint` and `pnpm format:check` clean (ESLint + Prettier, ADR 013).
3. `pnpm test` green, including the relevant acceptance scenario(s); `pnpm coverage` meets the gates (`06-testing.md`).
4. Docs touched by the change are updated in the same commit; no doc/code disagreement.
5. Any deviation from these docs has an ADR.
6. For CLI changes: output still matches the Figma terminal frames (snapshot tests pass).
7. For agent-facing changes: emitted traces and an eval (or an explicit, reasoned `n/a`) are present and described in the same commit — peer to tests and docs (ADR 052).
8. Landed via the git workflow above (ADR 106): a **squash-merged PR** with the `gates` CI green — never a direct push to `main`. Locally, items 1–3 run as the fast pre-push smoke; CI is the authoritative gate.

## Naming

- Terminology: the glossary in `brand.md` §5 / `docs/glossary/terms.ts` (ADR 296). The original five (Team, Member, Presence, Surface, Act) stay; the load-bearing set also includes agent (kind/hook), member (noun), seat (durability), role, toolkit (not `profile`), workspace, harness, driver, scope (not lane-surface), permissions, capability. No synonyms. Enforced by `pnpm vocab:check` (ADR 098 work-item table on ADRs ≥ 098; ADR 296 terminology table on ADRs ≥ 300 and new user-facing files).
- Files: kebab-case. Types/interfaces: PascalCase. Functions/vars: camelCase. Constants: SCREAMING_SNAKE for true constants (`HEARTBEAT_INTERVAL_MS`).
- Package names: `@musterd/protocol`, `@musterd/server`, `@musterd/mcp`, `@musterd/cli`. The CLI keeps the bin name `musterd`; its package is scoped because unscoped `musterd` is blocked on npm (ADR 009).
- **Work-item vocabulary (ADR 098).** Entities: **Goal**, **Lane** (the only code-backed work-item nouns). Field: `wave` (a Goal's shelf marker — `'later'` or unset; ADR 257 retired the numeric rank, and ordering is now derived from dependencies, status and recency). Generic: **work item** (lane-or-thread), **thread**. Sanctioned prose units: **Phase / P-N** (release arc), **increment N** (per-ADR cut, numbered within a named arc), **Task N** (plan-doc step headings only). Banned as structural tiers: `epic`, `milestone`, `sprint`, `story points`, and feature/task-as-tiers. Enforced on new docs (ADRs ≥ 098, plans ≥ 2026-07-06, new design docs) by `pnpm vocab:check` in the `format:check` chain; mention-not-use via backticks, deliberate use via `<!-- vocab:ok -->`.
