# 284 — The formatter writes only what the gate reads

- Status: accepted
- Date: 2026-08-19
- Deciders: izzo (measured it, built it), nick (asked for the never-again, not the fix)
- Relates to: ADR 182 (the writer validates what the reader parses — this is that shape, one level
  up), ADR 043 (checkers over generators for hand-authored content), ADR 052 (obs-evals gate)

## Context

`pnpm format` and `pnpm format:check` are the repo's formatting pair. AGENTS.md lists
`format:check` among the `gates` a PR must pass, and tells seats — in
`docs/architecture/07-conventions.md` §ADRs — **never to run Prettier on `docs/`**.

## Problem

**The two scripts governed different sets of files, and the writer's was enormously the larger.**

```
format        prettier --write  "**/*.{ts,js,mjs,json,md}"                       ← everything
format:check  prettier --check  "packages/**/*.ts" "tests/**/*.ts" "*.{ts,json}"
```

Measured on clean `main`, 2026-08-19: **`pnpm format` modifies 214 files.** 202 are under `docs/`,
5 under `scripts/`, and the rest are `README.md`, `ROADMAP.md`, `npm-reserve/`, `packaging/` and
`.cursor/`. Every one of them sits inside what the writer rewrites and outside what the checker ever
reads.

So the repo's own documented command rewrites 214 files that no gate governs, and no gate can report
that it happened. The `docs/` rule was discipline with nothing behind it: `.prettierignore` listed
`dist`, `node_modules`, `pnpm-lock.yaml`, `docs/design/assets`, `docs/assets`, `*.gif` and
`packages/web` — not `docs/`.

**It has bitten at least three seats**, most recently during the ADR 283 lane, which is what
prompted this one.

**And it does not present as a formatting problem.** Prettier rewraps `ROADMAP.md`; `ROADMAP.md`
then no longer matches `gen-roadmap.ts` output; `roadmap:check` goes red — and the seat goes hunting
in the roadmap generator for damage done by the formatter. Confirmed both directions on 2026-08-19:
red immediately after `pnpm format`, and _"ROADMAP.md is in sync with roadmap.data.ts"_ on the clean
tree. A seat that does not connect the two spends its afternoon in the wrong file.

This is [ADR 182](182-the-writer-validates-what-the-reader-parses.md) one level up. There the writer
had to validate what the reader parses; here **the writer's scope must equal the checker's scope.**

## Decision

**One list, two modes — the scopes are equal by construction, not by agreement.**

1. `scripts/format-scope.ts` exports `FORMAT_GLOBS`, the only list of paths Prettier governs here.
2. `scripts/format.ts` shells Prettier with that list and either `--write` or `--check`.
   `package.json` calls it both ways and carries **no glob of its own**.
3. `.prettierignore` gains the prose corpus (`docs/`, `README.md`, `ROADMAP.md`, `npm-reserve/`,
   `packaging/`, `.cursor/`). This is a **backstop, not a duplicate**: it governs the invocations
   `FORMAT_GLOBS` cannot see — a bare `npx prettier --write .`, an editor's format-on-save, a script
   nobody has written yet.
4. `scripts/format-scope.test.ts` asserts the construction is still standing: neither script names a
   glob, neither invokes `prettier` directly, no glob reaches markdown or `docs/`, and
   `.prettierignore` still carries the prose entries.

**Why a single list rather than a gate comparing two.** A gate that diffs two globs detects the
divergence after someone writes it. One list cannot diverge at all. The test in point 4 guards the
only remaining way back in — a seat in a hurry putting a raw `prettier --write <glob>` into
`package.json` — and that is a much narrower thing to watch than two lists drifting.

**Prose is excluded on its merits, not merely to stop the churn.** `docs/` is the decision spine:
an accepted ADR's `## Decision` is frozen, and wiki claims carry dates and falsifiers. A reflow
rewrites `git blame` for every line of an argument nobody was editing, which is a real cost paid in
the one corpus where "who wrote this, and when" is load-bearing.

**`scripts/` joins the CHECKED set** — it was in the writer's scope and outside the checker's the
whole time, including since #854 put it under typecheck, and it holds the gates that decide CI. The
5 files this made dirty are formatted once in the same commit.

## Consequences

`pnpm format` on a clean tree now changes **0 files**, down from 214. `pnpm format:check` covers
`packages/`, `tests/`, `scripts/`, `workers/` and the root files — strictly more than before — while
the writer covers strictly less.

Anyone who wants a path formatted adds it to `FORMAT_GLOBS`, which puts it under the formatter and
the gate in the same commit. That is the invariant; there is no way to add it to only one.

The 214 files are **left exactly as they are**. Reformatting them is a separate decision, and doing
it here would bury a 5-file fix under 214 files of noise.

## Observability & Evaluation

**Traces.** n/a — a build-tooling gate, emitting no acts and no spans.

**Eval.** _Dataset:_ the working tree itself. _Baseline, 2026-08-19:_ `pnpm format` on a clean
`main` modifies 214 files, 0 of which `pnpm format:check` verifies. _After:_ 0 files. _Falsifier,
and it is a one-liner anyone can run:_

```
git stash -u && pnpm format && git status --short    # expect no output
```

**Experiment.** None. The before/after is deterministic and reproducible on any clean checkout —
there is nothing here that needs a population or a window.
