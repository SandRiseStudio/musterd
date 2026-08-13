# 262 — Per-edge firing ledger + spend-level breaker

- Status: accepted
- Date: 2026-08-13
- Lane: `01KZY20ZRJ0SBH8WJ3CTFPKDP3`
- Builds on: [ADR 179](179-board-triggered-work-order-wakes.md), [ADR 250](250-loops-one-week-in-judgment-throughput.md) §4 item 1, [ADR 191](191-review-loop-wake.md), [ADR 199](199-dispatch-loop-wake.md), [ADR 131](131-harness-residency-wake-ledger-host.md)
- Relates to: ADR 189 (wakeability), ADR 236 (`lease_expired` vs sleeping host), ADR 247 (progress is not an outcome), ADR 253 (breaker does not ask a human)

## Context

Work-order wakes re-fire with no memory of the last firing on the same board edge. The review-loop
breaker (`REVIEW_LOOP_BREAKER_N` in `review.ts`) counts `lane.ready_for_review` rows, so a lane that
keeps leasing because sessions expire or fail before moving the lane never trips it. ADR 250
measured eight lanes waking the same seat two to five times each, and 14 `lease_expired` failures in
one day, on that blind spot.

Two further facts constrain the fix: `work_order` is not an edge (review and dispatch both emit it),
and an expired lease does not say whether the host spawned. Inbox wakes have the same churn shape
and are out of scope — they already have a per-act attempt cap.

## Problem

A work-order `(lane, edge)` can re-spend with no per-edge record of the last firing, so still-true
failures and repeated `lease_expired` keep buying sessions.

## Decision

`wake_leases` is the ledger. No second table. Stamp the edge at insert. Stamp `spawned_at` when the
host actually execs. At the next derivation, skip that `(lane_id, edge)` when the spend breaker has
tripped or the last reported failure is still true.

### 1. Edges — work-order only

`LOOP_EDGES = 'review' | 'dispatch_handoff' | 'dispatch_continuation'`. Mapped from today's
candidate constructors, not inferred later from act shape:

- `dueReviewWorkOrders` → `review`
- `dueDispatchHandoffWorkOrders` → `dispatch_handoff`
- `dueDispatchContinuationWorkOrders` → `dispatch_continuation`
- inbox `dueCandidates` → `NULL`

Inbox rows stay `edge = NULL`. The spend breaker never reads them.

### 2. Schema — additive columns, no summary table

`wake_leases` gains `edge TEXT NULL` and `spawned_at INTEGER NULL`, plus index
`(team_id, lane_id, edge)`. Pre-migration rows stay NULL/NULL. **Do not backfill** by inferring edge
from `act_id` / `lane_id` shape. There is no `delivered_at`. `created_at` remains "the poll
transaction committed." Still-true does not key on missing `spawned_at`.

### 3. Progress is a new route, not `wake-report`

`POST /teams/:slug/residency/wake-progress` `{ lease_id }` (agent-key auth). Presence of the POST
means spawned. Stamps `spawned_at` if null. Does **not** settle. Idempotent. Unknown id → 404.
Already settled → still stamp if `spawned_at` is null. Do not extend `WakeReportBody`. `edge` does
not go on `WakeOrder`.

### 4. Router skip — still-true closed set; breaker counts failures

For a work-order candidate, after existing exhaustion/attempt-cap checks and before INSERT:

1. If `WORK_ORDER_EDGE_BREAKER_N` (3) **`residency.wake_failed` rows** already exist for this
   `(team, lane_id, edge)` — including reaper `lease_expired` — skip, write `residency.wake_exhausted`
   with `detail.breaker: true` and `detail.edge`. Count failures, **not** `residency.woke` and not
   `lane.ready_for_review`. Three successful continuation wakes on the same claimed lane must still
   derive — that edge is the chaining primitive (ADR 199).
2. If the last reported `residency.wake_failed` on this `(lane_id, edge)` carries a still-true
   wakeability (`enrolled_dead_workspace`, `not_enrolled`) → skip with no second audit.

Transient (retry): `enrolled_seat_busy`, `enrolled_host_stale`, bare `lease_expired`, missing
`spawned_at`. Do not infer still-true from host log prose in `reason`.

`REVIEW_LOOP_BREAKER_N` is untouched and stays in `review.ts`. Breaker trip does **not** raise a
human ask (ADR 253). The lane is not wedged. Other edges on the same lane still fire.

### 5. Host

After the child is actually exec'd, `POST wake-progress`, then continue as today. `deferred`
outcomes and pre-spawn failures (dead workspace, missing backend, local-session defer) never
progress. A failed progress POST is loud in the host log and non-fatal. An old host that never
POSTs still wakes; `spawned_at` stays null; the breaker still counts reported failures.

### 6. Out of scope

Inbox / `immediate` / `batched` reply wakes; `delivered_at`; merge loop / capability-fitness /
acceptance absorption (ADR 250 items 2–4); loops-as-data; changing `REVIEW_LOOP_BREAKER_N`;
backfilling `edge`; human ask on breaker trip; bumping `FEATURE_EPOCH`.

## Consequences

- Work-order re-spend on a still-true failure or a three-failure edge stops at derivation, not at
  the host.
- Continuation chaining (ADR 199) keeps working: `woke` does not count toward the breaker.
- Old hosts and old daemons degrade: progress 404 is non-fatal; null `spawned_at` still derives.
- Pre-migration rows are invisible to the new counter (cold start, no backfill).

## Observability & Evaluation

**Traces.** `residency.wake_leased` / `woke` / `wake_failed` gain `detail.edge` on work-order rows. `spawned_at` lives on the lease row. Breaker trip is `residency.wake_exhausted` with `detail.breaker: true` and `detail.edge` — a counted event on a verb that already exists. `deriveWakeMetrics` is not required to split on edge in this increment; the rows must be queryable.

**Eval.** Dataset: ADR 250's eight-lane / 2–5× cluster and the 14 `lease_expired` day. Success: repeat work-order wakes on the same `(lane, edge)` with an unchanged still-true reason → ~zero; breaker trips are a counted event, not a silent skip. Disproof: a `enrolled_dead_workspace` report followed by another lease on that same edge.

**Experiment.** Cold-start after deploy (no backfill). Compare work-order lease repeats per `(lane, edge)` in the week after vs the ADR 250 snapshot. Inbox repeats are a control — they must not move.
