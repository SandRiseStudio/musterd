# 260 — Live acceptance pick skips a busy agent

- Status: accepted
- Date: 2026-08-12
- Owner: wanderer
- Relates to: ADR 188 (graded live pick), ADR 191 (wake when live pick is null), ADR 219 (quiescence already marks busy *offline* seats unspendable), ADR 252 (wake cost is under-priced on the failure path), ADR 253 (agents-only live pick), quiet-set spec increment 1

## Context

`pickReviewCounterpart` filters candidates with `hasLivePresence`. On revive, live usually means heads-down. Named live accepts hit the 10-minute bar 24% of the time; busy named agents eventually confirm ~80% at mean 273 minutes. ADR 219 already refuses to *wake* a busy seat. The live pick still targets them.

## Problem

Presence is not reachability. Sole-targeting a mid-turn agent plus ADR 202 (only the named seat can `accept`) is the 273-minute path.

## Decision

The live agent pick drops a candidate when `resolveQuiescence` on their newest work audit is `busy` (line = `QUIESCENCE_DEFAULT_QUIET_AFTER_MS`, 120s). `unknown` (no work audit in lookback) stays eligible. `occupancy.model_attested` is not work. `pickHumanReviewer` is not filtered. A null live pick still takes the ADR 191 wake path.

## Consequences

A team whose every live cross-model agent is mid-turn will wake an offline seat (or `no_candidate`) instead of asking the busy one. Evenings on revive are exactly that shape — everyone live, everyone heads-down — so increment 1 shifts volume onto the ADR 191 paid-wake path. Increment 2 (eligible-set fan-out) is not implied; measure first, including that wake cost.

## Observability & Evaluation

**Traces.** None new. The ready-row still records `reviewer` + `route` + `grade`. A wake that used to be a live pick is already visible as `wake_queued`.

**Eval.** Dataset: `lane.ready_for_review` joined to `lane.closed` on revive, **after** `stakes_defaults packages/web/**=low` was armed, non-exempt.

1. Counterpart confirm in ≤10 minutes among live-routed submits (`wake_queued` false). Baseline: 24% (14-day live named). A jumped route is `closer != ready-row reviewer AND closer != owner` — classify by join; drop those from the confirm numerator (do not hand-exclude #779).
2. Wake-route volume before vs after this ADR (`wake_queued` / ADR 191 path, plus `residency.woke` and unpriced sessions). ADR 252: `cost_usd_total` under-prices the failure path, so count leases and unpriced sessions, not only attested spend. A 10-minute-rate win bought with extra paid wakes is not a win.

**Experiment.** None. Observational before/after on the live log. If (1) does not move and stalls are attention-while-quiet, do not build increment 2 from this ADR. If (1) moves and (2) rises sharply, the next lever is whether that wake cost is acceptable.

- **2026-08-13 — the window is confounded from day one** (stanley, acceptance of #785 / lane
  `01KZ9FNC6VQ8NJH7R2KAMCV5D1`; the Decision is frozen, this note governs the Eval). The dataset is
  conditioned on "after `stakes_defaults packages/web/**=low` was armed", but that window also
  contains #768 (relayed authorization became a countable third acceptance shape), #771 (the `why`
  slot stopped serving discharged handoffs), #773 (value-layer outcome notes / claim-time linking /
  `stale_acceptance` visibility), **and the arming itself**. Arming does not only shift latency: it
  **removes no-risk web-only lanes from acceptance**, changing the population being measured, not
  only its speed. Four interventions plus a composition change, on a team where a handful of lanes
  moves any statistic.

  The read stays valid in the **disproof** direction: a 10-minute rate that fails to move indicts
  increment 1 regardless of the confounds' sign (none of them aimed to make busy-agent targeting
  *worse*). Any *credit* read — "increment 1 moved the rate" — must name the whole stack, not this
  ADR alone.
