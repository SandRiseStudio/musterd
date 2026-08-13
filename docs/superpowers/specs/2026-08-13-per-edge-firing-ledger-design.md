# Per-edge firing ledger + spend-level breaker

- Date: 2026-08-13
- Lane: `01KZY20ZRJ0SBH8WJ3CTFPKDP3`
- Goal: `board-loops`
- Author: wanderer
- Status: design, approved in brainstorm — not yet implemented
- Relates to: ADR 179 (umbrella), ADR 191 (review loop), ADR 199 (dispatch loop), ADR 250 §4 item 1 (this increment), ADR 131 (wake leases), ADR 189 (wakeability), ADR 236 (lease_expired vs sleeping host), ADR 247 (one payload, two consumers), ADR 253 (breaker does not ask a human)

This increment writes its own ADR (number from `pnpm adr:next` at implementation). ADR 179 stays the umbrella; ADR 250 stays the sequenced backlog. Do not amend either Decision.

## Problem

Work-order wakes re-fire with no memory of the last firing on the same board edge.

The review-loop breaker (`REVIEW_LOOP_BREAKER_N = 3` in `packages/server/src/store/review.ts`) counts `lane.ready_for_review` audit rows. A lane that keeps leasing wakes because sessions expire or fail before moving the lane never trips it. ADR 250 measured eight lanes waking the same seat two to five times each, and 14 `lease_expired` failures in one day, on that blind spot.

Two further facts from the ADR 250 amendment constrain the fix:

1. **`work_order` is not an edge.** Review and dispatch both emit `derivation: work_order`. Keying on derivation repeats the measurement trap.
2. **Expired rows do not say where the failure was.** "Host received the order and never spawned" and "host spawned and the session died before reporting" are identical `expired` leases. `wake_leases` has no `spawned_at`. A row existing *does* prove the poll transaction committed (no phantom leases). It does not prove a process started.

The inbox path has the same churn shape (one act re-leased four times). It is **out of scope** here: those wakes already have a per-act attempt cap, they are cheaper (reply watchdog, not `work_timeout_ms`), and mixing an `act_id` key with a `(lane, edge)` key is how this increment stops being "small, and first."

## Decision

`wake_leases` is the ledger. No second table. Stamp the edge at insert. Stamp `spawned_at` when the host actually execs. At the next derivation, skip that `(lane_id, edge)` when the spend breaker has tripped or the last **reported** failure is still true.

### 1. Edges — work-order only

```
LOOP_EDGES = 'review' | 'dispatch_handoff' | 'dispatch_continuation'
```

Mapped from today's candidate constructors, not inferred later from act shape:

| Constructor | `edge` |
| ----------- | ------ |
| `dueReviewWorkOrders` | `review` |
| `dueDispatchHandoffWorkOrders` | `dispatch_handoff` |
| `dueDispatchContinuationWorkOrders` | `dispatch_continuation` |
| inbox `dueCandidates` | `NULL` |

Inbox rows stay `edge = NULL`. The spend breaker never reads them.

### 2. Schema — additive columns, no summary table

`wake_leases` gains:

- `edge TEXT NULL` — one of `LOOP_EDGES`, or NULL
- `spawned_at INTEGER NULL` — host-acked spawn, ms epoch

Index `(team_id, lane_id, edge)` for the router read. Pre-migration rows stay NULL/NULL. **Do not backfill** by inferring edge from `act_id` / `lane_id` shape.

`created_at` remains "the poll transaction committed." There is no `delivered_at` and no "I got the JSON" ack. The lost-HTTP-body-after-commit case stays indistinguishable from never-spawned; still-true does not key on missing `spawned_at`, so three lost poll responses cannot trip the breaker as "host never spawns."

### 3. Progress is a new route, not `wake-report`

`POST /teams/:slug/residency/wake-progress` `{ lease_id }` (agent-key auth, same as the sibling wake routes). Presence of the POST means spawned. Stamps `spawned_at` if null. Does **not** settle. Idempotent (already stamped → 200). Unknown id → 404. Already settled → still stamp if `spawned_at` is null (occupied report can beat progress).

Do not extend `WakeReportBody`. That route already means outcome (settle / defer / supplementary cost). Progress is not an outcome (ADR 247).

`edge` does not go on `WakeOrder`. The host never needs it.

### 4. Router read — before insert in `claimWakeLeases`

For a work-order candidate, before inserting the lease:

1. If `WORK_ORDER_EDGE_BREAKER_N` (3) **failed** leases already exist for this `(team, lane_id, edge)` → skip, write `residency.wake_exhausted` with `detail.breaker: true` and `detail.edge` (no new audit verb — ADR 179 rides detail on existing rows), continue to the next candidate. Count `residency.wake_failed` rows (including reaper `lease_expired`) on that edge, **not** `residency.woke`. Three successful continuation wakes on the same claimed lane must still derive — that edge is the chaining primitive (ADR 199).
2. If the last **reported** `residency.wake_failed` on this `(lane_id, edge)` carries a still-true reason → skip. The failure row is the reason; do not write a second audit.

`REVIEW_LOOP_BREAKER_N` is unchanged and stays in `review.ts`. It still counts ready-entries. This increment does not reuse it.

Breaker trip does **not** raise a human ask (ADR 253: a non-risky breaker does not fall through to a human; asking nick is the load ADR 250 is cutting). The lane is not wedged: it stays in its current state. Other edges on the same lane still fire (a dead review wake must not block dispatch continuation).

### 5. Still-true — closed set, reported reasons only

Still true (skip):

- `enrolled_dead_workspace`
- `not_enrolled`

Transient (retry):

- `enrolled_seat_busy`
- `enrolled_host_stale`
- bare `lease_expired`
- missing `spawned_at` on an expiry (observability split only)

A later increment may widen the set. Do not infer still-true from host log prose in `reason`.

### 6. Host

After the child is actually exec'd, `POST wake-progress`, then continue as today. Pre-spawn failures (dead workspace, missing backend, local-session defer) go straight to `wake-report` and never progress.

A failed progress POST is loud in the host log and non-fatal. The wake still reports. An old host that never POSTs progress still wakes; `spawned_at` stays null; the breaker still counts leases and reported reasons. An old daemon without the route: host 404s, logs, continues.

## Out of scope

- Inbox / `immediate` / `batched` reply wakes
- `delivered_at` host ack
- Merge loop, capability-fitness routing, acceptance absorption (ADR 250 items 2–4)
- Loops-as-data
- Changing `REVIEW_LOOP_BREAKER_N` or teaching it to count leases
- Backfilling `edge` on existing rows
- Human ask on breaker trip

## Files (implementation, not this spec)

- `packages/protocol/src/residency.ts` (+ tests) — `LOOP_EDGES`, `WakeProgressBodySchema`
- `packages/server/src/db/migrations.ts` — columns + index
- `packages/server/src/store/residency.ts` (+ tests) — stamp `edge`, router skip, progress helper
- `packages/server/src/transport/http.ts` (+ `residency-http.test.ts`) — `POST …/wake-progress`
- `packages/cli/src/client.ts` — progress client
- `packages/cli/src/host/loop.ts` (+ tests) — POST after exec
- `docs/decisions/NNN-*.md` — this increment's ADR
- `docs/architecture/02-protocol.md`, `03-server.md`, `04-cli.md` — living docs in the same commit as the behavior

`packages/server/src/store/review.ts` is **not** in the change set. The bounce counter stays there; the spend breaker lives next to `claimWakeLeases`.

## Error handling

| Case | Behavior |
| ---- | -------- |
| Unknown `lease_id` on progress | 404 |
| Progress already stamped | 200, no-op |
| Progress after settle, `spawned_at` still null | stamp, 200 |
| Progress POST fails on host | log, continue to `wake-report` |
| Old host, no progress | wake works; `spawned_at` null |
| Old daemon, no route | host 404, log, continue |
| Breaker trip | skip that edge, audit, do not wedge, do not ask a human |
| Pre-migration / `edge = NULL` rows | invisible to the new counter (cold start) |

## Tests

Through-DB unless noted:

- Stamp `edge` on the three work-order constructors only; inbox leases stay NULL.
- Same lane, two edges → two counters.
- Last reported `enrolled_dead_workspace` or `not_enrolled` → skip. `enrolled_seat_busy` or `lease_expired` → retry.
- Trip at 3 **failed** leases on that edge (`wake_failed` / `lease_expired`), not 3 `lane.ready_for_review` rows and not 3 successful `woke` rows. The old bounce counter is not this test. Three `woke` continuation leases on the same lane still derive.
- Progress HTTP: stamp, no settle, idempotent, 404 unknown; stamp-after-settle if null.
- Host: progress after exec, not on dead-workspace short-circuit; progress failure does not skip `wake-report`.
- Null `spawned_at` (old host) still derives; breaker still counts leases.

## Observability (lifts into the ADR)

**Traces.** `residency.wake_leased` / `woke` / `wake_failed` gain `detail.edge` on work-order rows. `spawned_at` lives on the lease row. Breaker trip is `residency.wake_exhausted` with `detail.breaker: true` and `detail.edge` — a counted event on a verb that already exists. `deriveWakeMetrics` is not required to split on edge in this increment; the rows must be queryable.

**Eval.** Dataset: ADR 250's eight-lane / 2–5× cluster and the 14 `lease_expired` day. Success: repeat work-order wakes on the same `(lane, edge)` with an unchanged still-true reason → ~zero; breaker trips are a counted event, not a silent skip. Disproof: a `enrolled_dead_workspace` report followed by another lease on that same edge.

**Experiment.** Cold-start after deploy (no backfill). Compare work-order lease repeats per `(lane, edge)` in the week after vs the ADR 250 snapshot. Inbox repeats are a control — they must not move.
