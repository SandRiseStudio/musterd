# 303 — Auditable review selection

- Status: accepted
- Date: 2026-08-21
- Owner: gptbot
- Relates to: ADR 188 (graded review selection), ADR 219 (quiescence), ADR 260 (quiet live
  selection), ADR 301 (attestation source)

## Context

ADR 260 moved the acceptance evaluation from latency to top-reviewer concentration. Its
pre-registered prediction used the first ready row that named a second distinct
minority-family reviewer as the boundary. The evaluator reconstructs reviewer family from the
latest `occupancy.model_attested` row for each Member, not the attestation that existed when the
ready row was created.

That reconstruction cannot answer why one Member was selected. It cannot distinguish a Member
who was absent, busy, ungradeable, or filtered by the agents-only rule from an eligible Member who
lost the grade comparison. On the historic dual-minority interval, Wanderer received 30 review
asks and gptbot received 5; the audit has enough evidence to describe that skew, but not enough to
attribute it to the selection rule.

## Problem

An evaluation that infers the candidate set after the fact can turn a changed attestation or a
missing Presence history into a verdict about routing. The current concentration `FAIL` is
therefore descriptive evidence, not a valid disproof of the grade ladder. Changing routing or
building eligible-set fan-out from it would repeat the unreadable-window error ADR 260 was meant to
avoid.

## Decision

Each `lane.ready_for_review` audit detail will carry a decision-time review-selection snapshot.
The snapshot will contain the selected reviewer, their grade, and every candidate considered with
its then-current model family, eligibility verdict, and a bounded exclusion reason. The reason
vocabulary will distinguish at least self, service or observer, no live Presence, busy, unknown or
same-model grade, and lower grade. It will carry Member names only; never credentials, session
identifiers, transcript paths, or raw Presence ids.

The snapshot is evidence, not a new routing policy. The picker keeps ADR 188's grade order and ADR
260's busy filter. Historical rows without a snapshot remain descriptive-only and cannot settle a
causal claim about selection.

The successor evaluation begins only after this evidence is live. It will first measure rows where
two or more cross-family candidates were simultaneously eligible, then compare the chosen Member
with the recorded grade and deterministic order. It will not re-use a boundary inferred from later
attestations. Any change to candidate selection, fan-out, or the protocol remains a separate
decision.

## Consequences

The current ADR 260 concentration result remains useful for finding a skew, but its `FAIL` does
not authorize a routing change. The near-term cost is a larger audit detail on ready rows; the gain
is that a future reviewer can reproduce a selection decision without reconstructing ephemeral
Presence from unrelated acts.

The new snapshot creates a stable seam for later questions about model source, quiescence, roster
order, and harness reachability. It does not claim that any one of them currently causes the skew.

## Observability & Evaluation

**Traces.** Every live review selection continues to emit `lane.ready_for_review`; its detail gains
the bounded snapshot. Selection paths that produce `wake_queued`, `no_candidate`, or a required
human reviewer record their own explicit outcome rather than pretending to have a live candidate
set.

**Eval.** Dataset: ready rows emitted after the snapshot ships. Coverage is 100% of live selections
with a parseable snapshot. The attribution read is restricted to rows with at least two
simultaneously eligible cross-family candidates. It reports candidate-set frequency, selected
Member share within each identical ordered candidate set, and exclusion-reason counts.

**Experiment.** Observe at least 20 qualifying rows without changing review selection. If the
selected Member always matches the snapshot's deterministic order, concentration is policy plus
availability; if it does not, investigate the selection implementation before changing the policy.
