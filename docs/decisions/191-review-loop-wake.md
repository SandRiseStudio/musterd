# 191 — Review-loop wake: spend from the marked `wake_pool` (ADR 179 increment 5)

- Status: accepted
- Date: 2026-07-31
- Builds on: [ADR 179](179-board-triggered-work-order-wakes.md) (the review loop this
  implements), [ADR 187](187-durable-model-attestation.md) (pick a wake target on
  evidence), [ADR 189](189-wake-pool-wakeability.md) (spend only `wakeable` marks),
  [ADR 188](188-graded-review-ladder.md) (the ladder the offline pick reuses),
  [ADR 169](169-two-stage-close.md) / [ADR 131](131-harness-residency-wake-ledger-host.md).
- Lane: `01KYKH2SCCNAM3CZCA5G5010BM` (board title still says "ADR 169 inc 5" —
  cosmetic; ADRs 187–189 pin this id as ADR 179 increment 5).

## Context

`lane_ready` still records `no_candidate: true` whenever nobody eligible is **live**,
even when `wake_pool` names a spendable cross-family or cross-model remedy. ADRs 187
and 189 made the pool honest (family + wakeability) so a wake target can be chosen
on evidence. They deliberately did not spend. ADR 179's review loop is the spend
decision — behind toggles that default off.

The board lane was originally titled for ADR 169 §5 (mint an ephemeral cross-family
reviewer). That is a different spend shape (new process, ask-gated first spin-up).
This increment wakes an **existing enrolled** seat from the pool. Ephemeral mint stays
parked on ADR 169 §5.

## Problem

Without a wake from the pool, two-stage close stays theater on a monoculture roster:
the worker's ≤5 m window expires, the close records `no_candidate`, and the
review-catch rate stays structurally zero. Making every `ask` wake-eligible would
also wake consults and escalations — too wide. A reply-only doorbell is too thin for
a code review (needs workspace tools). The review loop needs a **work-order** wake
scoped to this one board edge.

## Decision

### 1. Toggles (defaults off — the trust ramp)

- Per-seat residency policy field `flow: 'manual' | 'auto'`, default `'manual'`.
  At `manual`, behavior is bit-identical to today for this seat as a wake *target*.
- Per-team `loops.review: boolean`, default `false`. When false, the ready edge
  never queues a review wake for anyone.

A review wake fires only where **both** agree: the team enabled the review loop
**and** the target seat is `flow: auto`.

### 2. Offline pick — same ladder, durable evidence

When `pickReviewCounterpart` (live) returns null and the lane is not the
risky-lane "human required / none live" shape:

1. Read `teamFamilyPosture().wake_pool`.
2. Keep only `wakeability === 'wakeable'`.
3. Grade each against the worker's attested model via `reviewGrade` (durable
   family/model for the idle seat — ADR 187), using the ADR 188 ladder:
   `cross_family` > `cross_model`. Never route `same_model` or ungradeable.
4. Best candidate is the offline reviewer.

Risky lanes with no live peer still fall back to a live human (unchanged). This
increment does **not** wake a human and does **not** wake for the
`human_review_missed` path.

### 3. Ready edge — ask + work-order, or sanctioned self-close

When the offline pick succeeds **and** both toggles agree:

- Deliver the ordinary lane-review `ask` to that seat (same meta as a live pick).
- Audit `lane.ready_for_review` carries `reviewer`, `review_grade`,
  `wake_queued: true` (not `no_candidate`).
- The worker's review contract stretches to the work-order watchdog
  (`work_timeout_ms`, default 30 minutes): wait that long; silence → self-close
  unverified. A failed/deferred wake must still degrade — never a wedge.

When toggles disagree or no wakeable graded candidate exists: keep today's
`no_candidate` + sanctioned self-close (posture line unchanged).

### 4. `claimWakeLeases` gains a `work_order` derivation (review only)

For each seat enrolled to the polling host that is offline, under caps, with
effective `flow: auto`, and with team `loops.review`:

- Find an unanswered directed `ask` with `meta.lane_review` addressed to that
  seat whose lane is still `ready_for_review`.
- Lease it as derivation `work_order` (audit `detail.derivation`), composed line
  carries seat / team / lane id only (ADR 179 injection bar — no title, no body).
- Force `tool_policy: 'seat-policy'` and `bounds.timeout_ms: work_timeout_ms`
  on the order (coding session, not reply-only). The lease row's `lane` column
  stays `batched` for the existing CHECK constraint; derivation rides the order
  + audit, not a new CHECK value.

Inbox `immediate`/`batched` derivation is unchanged. This increment does **not**
make arbitrary `ask` acts wake-eligible.

`work_timeout_ms` lives on `ResidencyPolicy` (default 1_800_000), applied only
to work-order orders. The host `--timeout` ceiling clamp stays a known ADR 179
open (loud-clamp later); until then, operators raising the review loop should
raise the host ceiling to match.

### 5. Circuit breaker (ships with the loop)

A per-lane count of `claimed`/`active` ↔ `ready_for_review` transitions (from
`lane.ready_for_review` + `lane.review_sent_back` audit rows) trips after **N = 3**
bounces. A tripped lane raises a **blocking** `ask` to a live human instead of
another work-order wake. Recorded, not amortized into spend. Never wedges.

### 6. Deliberately out of scope

- Dispatch loop (handoff / continuation edges) and merge loop.
- ADR 169 §5 ephemeral reviewer mint.
- Nullable `wake_leases.act_id` (dispatch continuation's need, not this one's —
  the review ask supplies `act_id`).
- Per-derivation rate-cap split (needs `detail.derivation` on
  `residency.woke`/`wake_failed` first — this increment writes it so the split
  can land later).
- Closing the remaining ADR 179 **gate** ledger items. A dark feature (defaults
  off) does not automate a known-broken rail; enabling on a dogfood team is an
  owner call after a measured smoke, not this PR's job.

## Consequences

- **2026-08-12 — non-risky breaker no longer asks a human.** [ADR 253](253-non-risky-lanes-never-ask-a-human.md)
  amends §5: a tripped breaker on a non-risky lane still stops spending wakes, but degrades to
  sanctioned self-close instead of a blocking human ask. §5's Decision text stays frozen. Risky
  lanes never entered this block.

- Protocol: `ResidencyPolicy.flow`, `ResidencyPolicy.work_timeout_ms`,
  `Policy.loops.review`, optional `WakeOrder.derivation` + `WakeOrder.lane_id`.
- Defaults keep every team bit-identical until an admin flips both knobs.
- Revive's cross-family remedies (`grokbot`, `compo`) stay `not_enrolled` until
  ops enrolls them — the loop will then prefer them; until then a wakeable
  `cross_model` peer (e.g. a different Claude checkpoint) can still be woken.
- Board title drift on `01KYKH2SCC` is left cosmetic; the lane detail names 179.

## Observability & Evaluation

- **Traces.** `lane.ready_for_review` gains `wake_queued` when a work-order is
  armed; `residency.wake_leased` / `woke` / `wake_failed` carry
  `detail.derivation: 'work_order'` and `detail.lane_id`. Circuit-breaker trips
  audit as `ask.raised` with breaker detail (existing ask machinery).
- **Eval.** Baseline: the eleven-row `no_candidate` series ADR 187 recorded
  (wake_pool 7–10, catch 0). Success after enable: at least one
  `wake_queued` ready row whose lease reaches `occupied`, and
  `review-catch` moves off structural zero without a human staging a reviewer.
- **Experiment.** Flip `loops.review` + one enrolled seat to `flow: auto` on a
  dogfood day; leave sibling seats manual. Pre-register: does a woken
  cross-family/cross_model reviewer catch defects worth the spend? If catch
  stays near zero or spend is ugly, do not enable the merge loop.
