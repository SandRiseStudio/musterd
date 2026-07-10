# 123 — cookoff measurement protocol: wasted-work predicate set v1 + interventions counting

- Status: accepted — freezes the measurement rules; the git-archaeology tool and the runs implement them
- Date: 2026-07-10

## Context

[ADR 122](122-cookoff-value-experiment.md) froze the cookoff experiment design and left three items
"open before the smoke run": freeze the wasted-work operational predicates, define the interventions
counting protocol, and pin the flagship model + harness. Its honesty rule is explicit: _"the
operational predicate set must be frozen and disclosed before the smoke run"_ — a ruler chosen after
seeing the result is not a ruler. The reference method is finding
[001](../research/001-telemetry-gaps-p3-dogfood.md)'s forensic reconstruction (the ≈37% anchor),
including its surviving-reimplementation exclusion.

## Problem

Turn ADR 122's abstract wasted-work definition into rules a script can evaluate with zero mid-run
judgment calls, computable from git alone in the daemon-dark control cells; and make the
interventions count comparable across cells that have completely different coordination media.

## Decision

Freeze **predicate set v1** and the **interventions counting protocol** as specified in
[`docs/design/cookoff-measurement.md`](../design/cookoff-measurement.md). The load-bearing choices:

1. **Four line-level predicates, fixed precedence W3 → W1 → W2 → W4:** duplicated work (patch-id
   equality or ≥8-line / ≥50%-of-smaller-hunk cross-actor overlap; later copy is the waste) →
   abandoned work (unreachable from delivered state and no patch-equivalent survivor) → clobbered
   work (cross-actor overwrite before run end; self-rework never counts) → conflict churn
   (`git merge-tree` auto-merge replay delta; squash cells via re-land patch-id drift). Each
   authored line classified once; wasted-work % = classified lines / authored lines, always reported
   with the per-predicate breakdown.
2. **Actor identity is git attribution only** (ADR 109 seat identities configured in every cell) —
   the controls must produce the number without a daemon (ADR 122 §5).
3. **Interventions = logged human touches, six codes (dispatch / unstick / answer / tie-break /
   conflict-resolution / correction),** kept as a per-run log in every cell; musterd cells pay full
   fare (each directed human act counts); kickoff prompts and pinned-identical permission policy are
   excluded; same human runs all cells of a set.
4. **tokens-to-done counts all usage-record tokens with a billed-cost roll-up** at the pinned
   model's pricing; coordination traffic is inside the transcripts, so overhead stays internalized.
5. **Predicate changes after the first smoke run are a new versioned set via ADR,** disclosed before
   the runs it scores. The W3 thresholds are explicitly flagged for calibration review at smoke.
6. **The model + harness pin stays open** — it is a spend/timing decision recorded in the run
   manifest (ADR 051) when the smoke run is scheduled, not a measurement rule.

## Consequences

- The git-archaeology Lane (`01KX6QBTJP5FR4B4APNC8FAE1E`) has an implementable spec: its acceptance
  bar is "computes predicate set v1 on a repo with configured actor identities."
- The skeptic's disclosure requirement is met: the ruler is public before any number exists, and
  the finding-001 rigor lessons (surviving reimplementations, self-rework) are structural
  exclusions, not analyst discretion.
- Comparability across cells is protocol, not hope: identical kickoff, pinned permission policy,
  one human, uniform touch log.
- Known approximation stands (ADR 122 "honest edges"): line-level predicates miss semantic
  duplication and may brush legitimate parallel edits; the acceptance-test guardrail and the
  breakdown reporting are the mitigations.

## Observability & Evaluation

- **Traces:** the measurement consumes traces, it does not add emitters — per-run artifacts are the
  git history, `interventions.log`, and harness usage records; musterd cells additionally reconcile
  the touch log against the message log (ADR 082 telemetry).
- **Eval:** the predicate set is itself evaluated at the smoke rung — run the archaeology tool on
  the finding-001 session history and confirm it reproduces the ≈37% figure within its 36–40% band
  before scoring any cookoff cell.
- **Experiment:** predicate set v1 is a pinned term of every cookoff manifest (ADR 051); varying it
  is a new predicate-set version, never a within-experiment knob.
