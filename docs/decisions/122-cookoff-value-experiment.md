# 122 — cookoff: the controlled experiment that proves musterd's value

- Status: accepted — freezes the cookoff evaluation design; implementation is unbuilt and tracked by the seeded Lanes
- Date: 2026-07-10

## Context

musterd's value thesis — coordinated agents beat siloed ones — has been carried by anecdote and one
forensic number: finding [002](../research/002-telemetry-caught-broadcast-journal.md) ("it caught us
journaling") and finding [001](../research/001-telemetry-gaps-p3-dogfood.md) (wasted work ≈ 37% of
code produced). Neither is a controlled comparison. Selling musterd — first target: **solo builders and
small teams, where the user is the buyer** — requires a defensible number: _with musterd vs. without,
on the same task._ This ADR freezes the design of the experiment that produces it, and the naming of
its fixture. The full narrative, reasoning, and parked alternatives live in
[`docs/design/cookoff-experiment.md`](../design/cookoff-experiment.md); this ADR is the decision.

The design was reached sell-first (reverse-engineer the task from the claim, not the reverse) in a
facilitated brainstorm on 2026-07-10, and it subsumes the evaluation agenda already sketched in
[`model-experimentation.md`](../design/model-experimentation.md): the same fixture answers the model
and harness questions when a different term is varied.

## Problem

Prove musterd adds _measurable_ value against an _honest_ baseline, isolating musterd as the only
variable, in a way that (a) maps to a felt pain the buyer already has, (b) survives a skeptic's attack
on the control, (c) counts musterd's own coordination cost against it so a win is a net win, and (d)
does not hard-couple the value story to git — musterd recommends git, it does not require it.

## Decision

### 1. The fixture is the **cookoff** — a fixed scenario configurations are run through

A **bespoke** small codebase (not in any training set) with a backlog of 6–8 tickets **engineered to
contain coordination traps** (a cleanly decomposable task shows nothing), each carrying a **hidden
acceptance test suite** (agents see ticket text; scoring sees tests). The core trap mix: two
**shared-surface** tickets, one **duplicate-scope** pair, one **hidden-dependency** ticket. Two further
traps — **cross-cutting refactor collision** and **mid-run spec change** — are reserved level-2
variants, not core. Name locked: `cookoff` (kitchen family — musterd is a condiment — and it names the
experiment shape: one recipe, many kitchens, judged plates).

### 2. One headline, two supports, one guardrail — never a single score

Carried from finding [005](../research/005-multimodel-parallel-work-telemetry.md): style ≠ outcome, so
every axis stays diagnostic, never a Member ranking.

- **Headline — wasted-work %**: authored code that never survives to the delivered state, or duplicates
  another actor's work (overlapping hunks, pre-merge clobbers, abandoned/superseded branches, conflict
  churn). Maps to the _clobbered-effort_ pain; finding 001's ≈37% is the baseline anchor.
- **Support — interventions-to-done**: human touches needed (tie-breaks, un-sticking, manual conflict
  resolution). Maps to the _attention_ pain; **absorbs "time saved"** (wall-clock is reported, never
  headlined — too noisy).
- **Support — tokens-to-done**: total tokens across all agents. Maps to the _money_ pain and
  **internalizes coordination overhead** — a win here is a net win.
- **Guardrail — acceptance-test pass rate**: blocks the "do nothing → zero waste" degenerate strategy
  (the gpt failure mode, finding 005). Objective and judge-free, so the headline experiment needs no
  LLM judge.

### 3. Five cells, two honest controls

`A` (1 agent, no musterd) · `B` (1 musterd agent) · `C2` (N agents, human-dispatched then independent —
the honest incumbent) · `C3` (N agents on a shared `TASKS.md` claim/status board — DIY musterd) · `D`
(N musterd agents). **D beating both C2 and C3 is the complete argument.** `C1` laissez-faire is
rejected as a strawman. The controls are where credibility lives, so we run two: C2 is _what the buyer
does today_, C3 is _what the buyer will say they'd do instead_ (and pre-empts "why not just a shared
file?" — each of its failure modes maps to a musterd primitive: stale claims → Lanes, no mid-task
interrupt → `steer`, no visibility → `seen_latency`/`open_loops`). The competitor comparison (CrewAI,
OpenAI Agent SDK) is **Phase 2** — it confounds harness and coordination and makes a different claim.

### 4. Variable isolation

The **ticket artifact is identical in every cell** — the same `TASKS.md` text; musterd cells seed
Goals/Lanes ([ADR 048](048-plan-goal-work-item-model.md) / [ADR 084](084-lanes-phase1-intent-dependency.md))
from that text. Same model family and same harness (Claude Code) across all cells; only musterd
presence and N vary. Each cell runs 3–5 times (single-run agent variance is brutal).

### 5. The metric is collector-agnostic; git is the reference collector

wasted-work is defined abstractly — artifact survival + authorship attribution — and **git is one
collector of that data, chosen by the benchmark, not required by the value story.** Two consequences:
(a) it must be computable from **git alone** in the control cells (A/C have no daemon telemetry), with
actor identity from git attribution, not musterd — the [ADR 109](109-seat-git-attribution.md) trick;
finding 001's method is the reference implementation. (b) **No non-git collector exists today** —
[ADR 090](090-per-recipient-delivery-status.md)'s delivery ledger is a message-journey read model that
never sees code artifacts, so it can carry the _supporting_ metrics in musterd cells but **not**
wasted-work; a harness-side workspace-snapshot collector (plausibly a batond feature) is reserved, not
designed. interventions and tokens are already git-free.

### 6. One instrument, three experiments

Vary **musterd/N** (A/B/C2/C3/D) → the sell (this ADR). Vary **model family** in cell-D → the Track A
per-model coordination leaderboard on the team + `model.family`-dimensioned metrics (#207), as
diagnostic profiles never a ranking. Vary **harness** in cell-D → harness evaluation (attestation
coverage — finding 005's 100% resident vs ≈5% CLI — becomes a benchmark row; residency, reachability,
whether a `steer` lands mid-task). Code _quality_, when scored, uses a **cross-family LLM judge** (judge
family ≠ author family — [ADR 101](101-model-as-a-variable.md)'s diversity idea applied to evaluation).

### 7. The run ladder gates spend

**Smoke** (1×D — prove the apparatus) → **Pilot** (A+D ×2 — confirm signal, fix the traps if flat) →
**Flagship** (all five cells × 3–5 — the published number). The scenario repo and scoring harness are
one-time costs that amortize into the [ADR 052](052-traces-evals-first-class-gate.md) baseline
infrastructure.

## Consequences

- **musterd has a defensible value claim, or learns it doesn't.** The double-control makes "D beats
  both C2 and C3" a hard result; the token metric makes it a _net_ result; the acceptance-test guardrail
  makes it an _honest_ one (waste didn't drop because work stopped).
- **The evaluation agenda collapses to one fixture.** The model-axis leaderboard and the harness eval
  stop being separate builds — they are the cookoff with a different term varied. `model-experimentation.md`
  Track A gains its concrete instrument.
- **The dataset is a byproduct, not a project.** Flagship runs emit labeled coordination transcripts
  across five cells — the reserved `coordination-dataset` item's producer, and the input the eventual
  fine-tuned coordination-judge ([ADR 110](110-track-b-tiny-model-lab-re-evaluation.md) Stage 2) is
  gated on. The [ADR 056](056-research-as-first-class-practice.md) ladder gets a live first rung.
- **The value story stays git-optional.** Defining the metric collector-agnostically keeps the pitch
  from claiming musterd needs git, while still using git as the richest available collector.
- **Nothing is built yet.** This ADR freezes design and naming only; the scenario repo, the
  git-archaeology tool, and the runs are future work (the seeded Lanes). No product code changes here.

## Observability & Evaluation

**Traces** — the cookoff runs _on_ the shipped instrumentation, it does not add emitters. musterd cells
carry the [ADR 082](082-instrument-by-default-telemetry.md) coordination telemetry and the #207 team +
`model.family` dimensions; the non-musterd cells (A/C) are deliberately trace-dark, which is the point —
their wasted-work is reconstructed from **git archaeology** (the collector this ADR defines), the same
forensic method finding 001 used when telemetry was inert.

**Eval** — the headline eval is **wasted-work % (D vs. C2/C3)**, with interventions-to-done and
tokens-to-done as supports and acceptance-test pass rate as the guardrail. _Dataset:_ per-cell git
history + workspace snapshots + the message/lane log in the musterd cells; the run set becomes the seed
of the `coordination-dataset`. _Baseline:_ cell A (single agent) and the C-cells, per the ADR 052
baseline requirement; finding 001's 37% is the standing prior. The guard metric against Goodhart is the
acceptance-test floor — a wasted-work drop is only counted if quality holds.

**Experiment** — the cookoff _is_ the experiment, run as an ADR 051 pinned manifest (fixed codebase +
tickets + model + harness; only musterd/N varied) on the smoke → pilot → flagship ladder. The same
manifest re-run with model family or harness varied is the model-axis / harness-axis experiment (one
instrument, three experiments). A coordination-traces benchmark scenario in the sense of
[ADR 111](111-stale-plan-detection.md)'s built-in A/B, generalized from two agents to the full matrix.

## Honest edges

- **wasted-work % from git alone is an approximation.** Overlapping-hunk / clobber / abandonment
  heuristics will miss semantic duplication (two different implementations of the same behavior) and
  over-count legitimate refactors. The operational predicate set must be frozen and disclosed before the
  smoke run; the acceptance-test guardrail is what keeps the approximation honest.
- **N=3 is a choice, not a law.** The traps are tuned for a small team; a different N changes the trap
  economics and is a separate manifest, not a free parameter within one run.
- **The result is about this task family.** cookoff measures coordination under _engineered_ collision.
  The claim it supports is "when agents' work collides, musterd recovers the waste," which is honest —
  it is not a claim that musterd helps on embarrassingly-parallel work, where by construction there is
  little to coordinate.
- **The self-diagnosis funnel is parked, not decided.** Whether wasted-work % can be computed on an
  arbitrary customer repo without musterd is unverified; the git-archaeology tool built here is its seed
  if it revives.
