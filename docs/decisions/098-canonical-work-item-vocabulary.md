# 098 — Canonical work-item vocabulary: the words for work, gated

- Status: accepted — canonical vocabulary + `vocab:check` gate shipped (#127)
- Date: 2026-07-06
- Builds on: ADR 048 (Plan/Goal model), ADR 084 (lanes join the Plan), ADR 052 (obs-evals gate — the
  checker pattern), ADR 085 (guidance drift-check precedent)

## Context

musterd's work-item ontology is deliberately small. ADR 048 gave the work itself a noun — the
**Goal**, a declared outcome whose status is always derived — and ADR 084 pinned the noun below it:
**Goal → work-item, two levels, not a recursive tree**, where a work-item is a **lane** (the only
work-item DB table) or, for a lane-less team, a thread. `wave` is a stored field on a Goal, not a
tier. ADR 048 already said the quiet part: "`epic`/feature/task reuse amprealize's vocabulary, but as
informal depth-labels over a flat `Goal → work-item` join … We keep the words, not the tree."

But nothing enforces the words. Plans, roadmap prose, and design docs are written across many
sessions by different models, and each one imports its own project-management ontology. A survey of
`docs/` today: `milestone` ~30 uses, `increment` ~18, `epic` ~7, plus "wave" drifting from the
stored field into a loose theme-word ("the reachability wave"). The result is that readers — human
and agent — infer entities that don't exist, and new ADRs get sketched against imagined tiers. This
is the lexical seed of the board-rot ADR 048 exists to prevent: vocabulary quietly re-importing
structure the data model rejected.

The repo already has the cure pattern: hermetic prose drift-checkers wired into `format:check`
(`check-arch-trees.ts` ADR 043, `check-obs-evals.ts` ADR 052, `check-guidance.ts` ADR 085), each
with pragmatic grandfathering (obs-evals gates from ADR 060 onward).

## Problem

Fix a canonical work-item vocabulary — which words name real things, which words are sanctioned
prose, which words are banned — and enforce it mechanically on **new** docs, without retrofitting
history (ADRs are immutable) and without adding any new entity, field, or table.

## Decision

### 1. The vocabulary, tiered

| Tier                        | Terms                                         | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Entities**                | **Goal**, **Lane**                            | The only work-item nouns backed by code: Goal (derived, message-backed — `packages/protocol/src/goals.ts`), Lane (the `lanes` table — `packages/protocol/src/lanes.ts`).                                                                                                                                                                                                                                                                                                                         |
| **Field**                   | **wave**                                      | A stored field on a Goal + the roadmap enum — a build-order rank. Use it as a field value ("wave 3", `wave: 'later'`), never as a freestanding theme-noun ("the reachability wave" → name the arc or the Phase instead). Prose ruling, not linted.                                                                                                                                                                                                                                               |
| **Generic**                 | **work item**, **thread**                     | "Work item" is the reconciled generic (ADR 048/084): a lane or, fallback, a thread. A thread is conversation, never a tier.                                                                                                                                                                                                                                                                                                                                                                      |
| **Sanctioned prose units**  | **Phase / P-N**, **increment N**, **Task N**  | Words, not entities. **Phase / P-N** = the release-arc slice (institutionalized in ADR filenames: `070-v0.3-p1`, `075-p3.3`). **Increment N** = the cut-within-an-ADR-arc, always numbered inside a named arc ("Layer 2, increment 3" — ADRs 088–091), never a freestanding backlog unit; it is a _sequencing_ word, not a container noun, so it does not threaten the no-tree rule. **Task N** = the step heading inside `docs/superpowers/plans/` docs only (external superpowers convention). |
| **Banned structural nouns** | `epic`, `milestone`, `sprint`, `story points` | Name structure musterd rejected. Linted in new docs (§3). `feature`/`task` **as tiers** ("Feature 3", `epic`→feature→task ladders) are banned by this ruling but not linted — ordinary English use ("this feature flags…") makes any regex hopeless, and "Task N" is sanctioned in plan docs.                                                                                                                                                                                                    |

Division of labor in one line: **Phase = release arc · Goal = declared outcome · Lane = owned work ·
increment N = per-ADR cut · Task N = plan-doc step.**

### 2. Mention vs. use

A banned word in backticks or inside a code fence is a **mention**, always legal — that is how this
ADR, the conventions table, and any doc quoting history name the banned words, with no special-casing.
A deliberate prose use (e.g. the celebratory "a real `milestone` for the project") is suppressed
line-level with `<!-- vocab:ok -->`. Prefer backticks; the comment is the fallback for headings.

### 3. Enforcement: `vocab:check`

`scripts/check-vocab.ts`, a fifth sibling in the `format:check` chain, same hermetic pattern as
`check-obs-evals.ts`. It masks code fences and inline code spans, skips `<!-- vocab:ok -->` lines,
then flags `/\bepics?\b/i`, `/\bmilestones?\b/i`, `/\bsprints?\b/i`, `/\bstory\s+points?\b/i` per
line. Scope and grandfathering (no retrofit — pragmatic, like obs-evals' `GATE_FROM`):

- `docs/decisions/` — ADRs **from 098 onward** (this ADR is in scope and self-hosts via §2).
- `docs/superpowers/plans/` — plans dated **2026-07-06 onward** (date-prefix compare), minus a
  small named-grandfather list if a same-day plan predates the gate.
- `docs/design/` — files **not on a frozen baseline list** of the docs existing at gate time (no
  date convention exists there; a rename off the list makes a doc "new", acceptable and rare).
- Not scanned: `docs/architecture/`, `AGENTS.md`, `README.md`, `ROADMAP.md`, code, everything else.

Not linted (prose rulings only): `feature`, `task`, `increment`, `phase`, `wave`, `backlog`.

### 4. Where the ruling lives

The compressed table goes in `docs/architecture/07-conventions.md` §Naming (sibling of the brand
glossary rule); `AGENTS.md` gains a one-line pointer. This ADR is the ruling of record.

## Consequences

- New docs are linted via `pnpm format:check`; existing docs are never retrofitted (ADRs are
  immutable; grandfathered prose in old design docs stays as history). The cost of a false positive
  (rare — e.g. celebratory "`milestone`") is one rephrase or a one-line suppression.
- This ADR adds **no** entity, field, table, act, or tool. It is words only. The standing bet from
  ADR 048 holds: minimal declared noun, derive everything else.
- **Phase-2 seam — when words stop being enough.** A follow-up ADR proposing a real intermediate
  entity (a grouping above Goal, or an owned step below Lane) is justified only on sustained dogfood
  signals, two or more of:
  1. recurring `vocab:ok` suppressions used to describe a _grouping_ concept (pressure to name a
     container keeps surfacing);
  2. `goal_id`-less lanes proliferating because Goals are too coarse to attach to;
  3. hand-synced cross-lane checklists or "% complete" mirrors reappearing in plans (the mirror-toil
     ADR 048 exists to prevent);
  4. arcs chaining 4+ increments whose increments start needing individually tracked status;
  5. `wave` getting overloaded with ordering semantics beyond the roadmap enum.

  Until then, the words stay words.

## Observability & Evaluation

**Traces.** None — no runtime surface; the gate is a repo check, not an agent-facing feature, and
emits no coordination acts or spans (ADR 051 does not apply).

**Eval.** The checker is the eval. Dataset: every gated doc on `main`. Baseline: 0 violations at
merge, `pnpm vocab:check` green. The drift signal over time is the count of `<!-- vocab:ok -->`
suppressions and backticked banned-word mentions in gated docs — cheap to grep, and it doubles as
Phase-2 signal (1).

**Experiment.** None yet — the Phase-2 seam criteria above are the named future test: if two or
more signals sustain, the vocabulary-only bet has failed and the follow-up entity ADR runs the
experiment.
