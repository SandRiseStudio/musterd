# 126 — Scope stale-work-caught to the warned lane/goal

- Status: accepted
- Date: 2026-07-10
- Amends: [ADR 125](125-steering-latency-metrics.md) (stale-work-caught predicate only)

## Context

ADR 125's `stale_caught` counted a wake as caught when the subject lane was abandoned/resolved
**or** when the owner posted any subsequent `accept` / `handoff` / `status_update` / `resolve`. The
second arm is unscoped: a routine `status_update` about unrelated work (or one act clearing many
pending wakes for that owner) over-reports, trending `stale_caught` toward `stale_wakes`. Flagged in
review of #216/#218.

## Problem

Make "caught" mean the owner changed course **on the warned work**, without new capture or a
wire-version bump.

## Decision

Keep the abandoned/resolved arm (already subject-lane-scoped). Replace the unscoped message arm
with: a subsequent owner act in `{accept,handoff,status_update,resolve}` that **references the
warned work** — either:

1. `meta.in_reply_to` names the wake act, or
2. `meta.goal_id` equals the subject lane's `goal_id` (when set), or equals the wake's
   `lane_warning.with` when that field is a Goal id (`stale_plan`).

Unrelated owner chatter no longer counts. One act still cannot clear wakes for other lanes unless
it names them.

## Consequences

- `stale_caught` stays a precision instrument for the launch-demo A/B; false positives from journal
  traffic drop.
- Agents that course-correct only via free-text status without `goal_id` / reply-to the wake are
  counted only if they abandon/resolve the lane — honest: the durable course-change is the lane
  verb.

## Observability & Evaluation

**Traces** — n/a (refines a derived metric; no new emitters).

**Eval** — same ADR 125 headline; guard is that `stale_caught ≤ stale_wakes` and that an unrelated
owner `status_update` after a wake does **not** increment `stale_caught`.

**Experiment** — none new; improves the ADR 125 A/B instrument's precision.
