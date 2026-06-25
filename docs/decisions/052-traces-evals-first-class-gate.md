# 052 — Traces & evals as definition-of-done: the first-class gate

- Status: proposed
- Date: 2026-06-24

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
- **Built here vs greenlit here:** the ADR template section and the DoD clause are documentation and land
  with this ADR. The `obs-evals:check` script is named as the this-week implementation task, tracked on
  the roadmap (`obs-evals-gate`), not written in this commit.
- Risk — gaming via empty/`n/a` sections — is bounded by the baseline-and-reason requirements and normal
  review; the gate guarantees the *question is asked*, not that the answer is good.
- Implements the day-to-day discipline ADR 051 depends on. Composes with ADR 041/043 (the checker
  family) and `07-conventions.md` (template + DoD).
