# 052 — Traces & evals as definition-of-done: the first-class gate

- Status: accepted
- Date: 2026-06-24 (gate built 2026-06-26)

## Context

The 2026-06-24 flywheel decision (ADR 051) sets the strategy: musterd emits coordination-native traces;
batond runs the eval/experiment engine. A strategy only becomes real if every new agent-facing feature
*ships* with its traces and evals, the way it already ships with tests and updated docs (the definition
of done, `07-conventions.md`). Otherwise telemetry is retrofitted later, which observability.md §1
explicitly calls out as always worse.

musterd already enforces structural discipline mechanically: `pnpm format:check` runs Prettier +
`roadmap:check` (ADR 041) + `arch-trees:check` (ADR 043, a *checker not generator* so each entry carries
a curated description). This is the muscle to reuse for a traces/evals gate.

## Problem

Make "traces + an eval" a first-class deliverable of every agent-facing feature — alongside code and
docs — cheaply, this week, without a platform and without cargo-culted evals written just to pass.

## Decision

- **ADR template gains an "Observability & Evaluation" section.** Every ADR for an agent-facing
  feature must answer:
  - **Traces** — what spans/events does this emit (coordination acts + agent-turn detail per ADR 051)?
  - **Eval** — what is its success metric, against what **dataset** and **baseline**? (An eval with no
    baseline is theater — the baseline requirement is the anti-cargo-cult guard.)
  - **Experiment** — what experiment would validate it (may be "none yet", but named)?
  Non-agent-facing or purely mechanical ADRs may write "n/a — <reason>".
- **Definition of done gains a clause:** an agent-facing change is done only when its emitted traces and
  its eval (or an explicit, reasoned `n/a`) are present and described in the same commit — peer to the
  existing tests/docs clauses.
- **A `format:check` guard enforces it (to build this week).** Add an `obs-evals:check` step to
  `pnpm format:check`, modeled on `check-arch-trees.ts`: a **checker, not a generator** — it fails an
  agent-facing ADR that lacks a non-empty "Observability & Evaluation" section (or an explicit `n/a`
  with a reason). It enforces *presence and shape*, leaving the content hand-authored, exactly as the
  arch-tree checker enforces the file set but not the descriptions.

## Consequences

- Cheap and compounding: from now on, features built through Waves 1–3 carry traces + evals by default,
  so batond's engine (ADR 051) has real data to consume when it lands — no retrofit.
- Reuses an existing, trusted mechanism (`format:check` + the ADR 043 checker pattern); low new surface.
- **Now built (2026-06-26):** the ADR template section (`07-conventions.md`), the DoD clause, and the
  `obs-evals:check` guard (`scripts/check-obs-evals.ts`, wired into `pnpm format:check`) all landed.
  The checker mirrors `check-arch-trees.ts`: it enforces *presence and shape* (the section exists and
  answers Traces / Eval / Experiment, or is an explicit `n/a — <reason>`), never content.
- **Grandfathering (pragmatic):** the gate enforces from **ADR 060 onward**. ADRs 001–059 predate it and
  are exempt — 052 is the gate itself and 056 already carries the section voluntarily; the rest are
  pre-gate history we do not retrofit. The DoD clause in `07-conventions.md` still asks every agent-facing
  change for the section regardless of number, so the practice runs ahead of the mechanical cutoff.
- Risk — gaming via empty/`n/a` sections — is bounded by the baseline-and-reason requirements and normal
  review; the gate guarantees the *question is asked*, not that the answer is good.
- Implements the day-to-day discipline ADR 051 depends on. Composes with ADR 041/043 (the checker
  family) and `07-conventions.md` (template + DoD).

## Observability & Evaluation

n/a as an agent-facing feature — this is a build-time documentation gate, not a runtime act, so it emits
no coordination traces. Its own success is measurable, though: the **eval** is the share of in-scope ADRs
(≥ 060) that carry a non-cargo-culted section — metric is reviewer-judged section quality, **dataset** is
the ADR corpus, **baseline** is the pre-gate state (only 056 carried it voluntarily). The **experiment**
worth running once batond exists: do features whose ADR named a real eval actually ship measurably better
coordination outcomes than those that wrote `n/a` — i.e. does the gate change results, not just paperwork?
