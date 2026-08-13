# Quiet-set acceptance — fan out who is asked, keep one discharge

- **Status:** increment 1 implementing (ADR 260); increment 2 not started
- **Date:** 2026-08-12
- **Author:** wanderer
- **Lane:** `01KZ9FNC6VQ8NJH7R2KAMCV5D1` (folded from the standing-acceptor capture)
- **Seed:** [docs/design/the-standing-acceptor.md](../../design/the-standing-acceptor.md)
- **Relates to:** ADR 188 (graded ladder), ADR 191 (review-loop wake), ADR 202 §3 (a verdict is never guessed — only the asked seat can `accept`), ADR 219 / 120s quiescence, ADR 225 (acceptance must reach someone), ADR 227 (roles — possible later eligible-set refinement, record-don't-build), ADR 234 / 244 / 253 (stakes + agents-only live pick), ADR 235 (do not self-close on silence when the sweep is armed), ADR 252 (wake cost), ADR 254 (eligible sets), ADR 258 (`review_debt`)

## The question this lane asked

Nick, 2026-08-05: maybe a standing seat on a different model that all approvals route to — and didn't we already wake someone like that?

**Answer: that seat exists. It is not the design.** ADR 191's review-loop wake is built, armed on revive (`loops.review=true`), and already receiving. A dedicated standing acceptor is a single point of failure, a monoculture of one, and — on this team — the same laptop as everyone else, so it is dark in the window it is most needed. The ladder already degrades. Do not build a roster costume for a deployment-topology problem.

What feels broken is routing, not supply of a special seat.

## Problem

`lane_submit` picks **one** live counterpart (`pickReviewCounterpart`), keyed on `hasLivePresence`. Live tonight means heads-down. The named ask lands in an inbox the acceptor will not look at for tens of minutes; ADR 202 §3 then **refuses** any other qualified seat who tries to `accept` — the ask was never addressed to them.

Measured on revive, last 14 days, agents only, **good = confirm in ≤10 minutes** (nick's bar, 2026-08-12):

| Route | n | good ≤10m |
| ----- | - | --------- |
| live named | 89 | **24%** (21) |
| wake | 27 | **19%** (5) |
| best live bucket (quiet 2–10m) | — | **32%** |

Busy named agents eventually confirm ~80% at mean **273 min** — after the worker's 5-minute hint, and after a 10-minute bar. Hours-later confirms are misses.

The board already lets any non-owner accept. In 14 days that happened **2/61** confirms (76 min and 992 min). Naming creates the obligation; others do not pick up. `@team` with no names is already measured as diffusion.

ADR 258's `review_debt` now advertises the oldest `awaiting_acceptance` lanes on everyone's `team_next`. It is the closest cousin to "open pickup" **and it cannot work as shipped**: an ambient reader is structurally unable to take an ask routed elsewhere (ADR 202 §3). That is the strongest existing argument for widening who is **asked**, at route time — not who is allowed to answer.

### Confounds the Eval must not swallow

- **Jumped route.** A `lane_resolve` by a non-owner records `verified: true` (closer ≠ owner) even when the routed counterpart never reviewed. Ready-row `detail.reviewer` already names who was asked; closer ≠ that reviewer AND closer ≠ owner is a jumped route **by join**. Classify from day one. Do not hand-exclude #779 — Miley flagged that exclusion will recur and silently inflate the baseline.
- **Attention, not absence.** izzo sat 3h on a named ask while live, cross-family, and qualified — misread the brief. Fan-out adds candidates to a problem that is sometimes attention. The 10-minute rate is still the primary; stall-*reason* is a secondary split if recoverable.
- **Denominator moved today.** ADR 253 (agents-only live pick) + nick armed `stakes_defaults: packages/web/** → low`. No-risk web-only lanes now mostly route no ask. Size increments against **post-arming** ask volume, not the 14-day mix.
- **Right-censoring.** ADR 229 sweeps at 24h. Median acceptance age among answered rows hides the tail. Use uncensored age-at-close (including `review_swept`) and the fraction >12h (stanley's ADR 258 Eval amendment).
- **Path exemption is not back.** The seed's "already decided, do not re-litigate" section recorded that a `packages/web` exemption was rejected. ADR 244 is a stakes **default**, not a hard exemption: risk tags defeat it, an explicit declaration wins either way, it fires at OPEN only. Mixed-surface lanes stay `normal`.

## Decision

**Fan out who is asked. Keep one discharge. Never sole-target a mid-turn live seat.**

Not a dedicated acceptor. Not `@team`. Not "anyone can answer an ask they were not sent."

### Eligible (live quiet set)

At `lane_submit`, for a **non-risky, non-exempt** lane:

1. Start from today's ladder (ADR 188 / 253): not the owner, not observer, not `service`, **agents only**, `cross_model` or better (never `same_model`, never unattested).
2. Drop anyone **busy**: quiescence state is not `quiet` (`QUIESCENCE_DEFAULT_QUIET_AFTER_MS` = 120s, ADR 219). `hasLivePresence` stays necessary (they must be reachable) and stops being sufficient.
3. Sort by grade (`cross_family` before `cross_model`), cap at `MAX_ELIGIBLE` (4).

Risky lanes (ADR 172) are unchanged: one live human, no agent fan-out. Exempt low (ADR 234 increment 2) is unchanged: no ask.

### Route

| Quiet-set size | What happens |
| -------------- | ------------ |
| **2–4** | One `ask` (`species: approve`, `lane_review` marker) addressed `to: {kind:'team'}` with `meta.eligible: [...]`. First `accept`/`decline` discharges everyone else (ADR 254 any-of). Stand-down names who took it. |
| **1** | Today's directed ask to that one quiet seat. ADR 254's floor is 2 names; do not invent a singleton eligible set. A quiet singleton is still the win versus targeting a busy seat. |
| **0** | Today's ADR 191 path: wake one offline eligible seat **if** the review loop is armed and the breaker has not tripped. Do **not** add a fake open-pickup via `review_debt` — that advertises work ADR 202 will not let them take. |
| **0 and nobody wakeable** | `no_reachable_acceptor`. Sanctioned self-close immediately. No fake 5-minute wait. |

### Interrupt, not inbox-class

ADR 254 made eligible-set `message` inbox-class on purpose ("either of you know?"). Acceptance is a 10-minute obligation, not a question. The `lane_review` marker already makes a directed acceptance ask **obligation-class** for the ADR 088 interrupt line (`pendingInterrupts` + `opts.obligations`). Extending `ELIGIBLE_ACTS` with `ask` is enough for `actionNeeded` to admit every named seat — the interrupt then fires for each of them, because `isObligation` keys on `lane_review`, not on `to.kind === 'member'`.

Do not mark the ask `urgent`. Obligation-class is the instrument ADR 225 already chose for live acceptors; urgent would also hit the paid wake rail, which ADR 254 increment 2 left unbuilt on purpose.

Busy seats are not in the set, so we do not interrupt a mid-turn agent. That is the whole point of the quiet filter.

### `owed_reviews` must see the set

Today `deriveNext`'s `owed_reviews` query joins `members mt ON mt.id = m.to_member`. An eligible-set act has `to_member = NULL`. Without a second clause, the fan-out ask would vanish from the brief that exists specifically to re-surface a missed acceptance (ADR 233). Match `json_extract(meta,'$.eligible')` containing me, same as the interrupt predicate.

`review_debt` stays ambient visibility (how long the oldest waits). It is not a pickup path.

### Worker clock — do not undo ADR 235

An earlier sketch said "wait 10 minutes, then sanctioned self-close" to match the success bar. **Withdrawn.** ADR 235 measured that the 5-minute hint produced unverified self-closes at mean 8.5 min, and 20/20 of those acceptors came back afterwards. Revive has `loops.sweep` armed. The submit hint stays: leave it with them; the daemon sweeps at 24h.

The **10-minute bar is the routing Eval**, not the owner hint. Changing the hint would recreate bucket A under a longer number.

### Protocol

`ELIGIBLE_ACTS` gains `ask`. That is an ADR-gated protocol change (amend ADR 254 or a new ADR that names the amendment). Roster validation is unchanged: live, non-observer, not the sender. The daemon is the sender of a `lane_review` ask (`from` = the worker); eligible names must not include the owner.

`LaneResultSchema.review` keeps `reviewer` (the best-grade name, wire-compat) and adds optional `eligible: string[]` when the set was used.

## What this is not

- **A standing acceptor seat.** Q1 of the seed, answered no. The ladder + wake already is that mechanism; making it a dedicated person fails closed on one laptop and one model.
- **Open pickup / `@team`.** Diffusion is measured. ADR 202 stays: only a named eligible seat (or the one directed recipient) can verdict.
- **Changing ADR 202 so ambient `review_debt` readers can accept.** That would guess a verdict the ask never addressed. If we ever want open pickup, it is a new ask, not a looser accept.
- **ADR 254 increment 2 (wake-one-hold-rest).** Still gated on urgent eligible-set traffic existing. This design's wake path is the existing ADR 191 single wake when the quiet set is empty.
- **Hand-declaring gptbot's model** so grading can certify it. ADR 187 / 158 stand. Ungradeable seats stay out of the set.
- **Re-routing in-flight asks** when a busy seat goes quiet. Eligibility is enumerated at submit (ADR 254 rule 1).

## Increments

Split so the first increment is measurable without the protocol change, and so we do not size fan-out against a denominator that just shrank.

**Increment 1 — stop targeting busy.** `pickReviewCounterpart` drops non-quiet live **agents**. Same one-name ask, same wake fallback. Independently useful: the 273-minute path is this filter's absence. Do **not** quiet-filter `pickHumanReviewer`: a risky lane still needs a live human (ADR 172), and dropping a busy nick would convert required human review into `human_review_missed`. Ship, then measure 10-minute hit rate **and wake-route volume** on **post-arming, non-exempt** submits for a few days. Evenings here are everyone-live-but-heads-down; increment 1 moves those submits onto the ADR 191 paid-wake path, and that shift has to be priced (eval item 5 / ADR 252).

**Increment 2 — quiet-set fan-out.** `ask` on `ELIGIBLE_ACTS`, compose `meta.eligible` when the quiet set is 2–4, fix `owed_reviews`, keep interrupt obligation-class. First accept wins. ADR + protocol in the same commit.

If increment 1 plus web-low already moves the 10-minute rate near the quiet-bucket 32% and ask volume is small, increment 2 may not be worth the protocol change. That is a real possible outcome; the Eval decides it.

## Observability & Evaluation

**Emitted (increment 2):** `meta.eligible` on the `lane_review` ask (self-describing, no new audit action). Ready-row `detail` gains `eligible: string[]` beside today's `reviewer` so the close edge can say who was asked, not just who was picked first.

**Eval, pre-registered, post-arming window only:**

1. **Good ≤10m** among routed (non-exempt) submits. Baseline: 24% live / 19% wake. Target: at or above the quiet-bucket 32% for quiet-set routes. A jumped route is `closer != ready-row reviewer AND closer != owner` — classify by join; drop those from the confirm numerator.
2. **Uncensored age-at-close** including `review_swept`, plus fraction >12h (do not use median-among-answered).
3. **Duplicate verdicts** on eligible-set asks. Predict ~1.0. Above 1.3 sustained → stand-down is not landing (same reopening trigger as ADR 254).
4. **Ask volume** per day after web-low, so increment 2 is sized against the new denominator.
5. **Wake-route volume** before vs after increment 1 (`wake_queued` / ADR 191 path, plus `residency.woke` and unpriced sessions — ADR 252: `cost_usd_total` under-prices the failure path). A 10-minute-rate win bought with extra paid wakes is not a win.

**Reopening:** if (1) does not move after increment 1 and the stalls are attention (live, quiet, still no look), fan-out will not save us — that is izzo's 3h counterexample, and the next lever is the interrupt copy / `owed_reviews` surfacing, not a wider set. If (1) moves and (5) rises sharply, the next lever is whether that wake cost is acceptable — not increment 2.

## Testing

- **Increment 1:** picker unit tests — a live busy cross-family agent loses to a quiet cross-model agent; a team of only-busy live agents falls through to wake / `no_candidate`; risky human pick is unchanged (live human, busy or not). Quiescence clock injected, same as existing ADR 219 tests.
- **Increment 2:** protocol — `ask` may carry `eligible`; `handoff` still must not. Integration — submit with two quiet peers inserts one row, `to_kind='team'`, `meta.eligible` length 2, both appear in `owed_reviews`, first accept closes the lane and stands the other down (CLI + MCP `discharged`). A third live-but-busy seat is not named and cannot `accept` (ADR 202). Exempt and risky paths unchanged.

## Blast radius

| File | Change |
| ---- | ------ |
| `packages/server/src/store/review.ts` | quiet filter on live pick (inc 1); return a set (inc 2) |
| `packages/server/src/transport/http.ts` | compose eligible-set `lane_review` ask when set ≥ 2 |
| `packages/server/src/store/orientation.ts` | `owed_reviews` matches eligible names, not only `to_member` |
| `packages/protocol/src/envelope.ts` | `ask` ∈ `ELIGIBLE_ACTS` (inc 2, ADR) |
| `packages/protocol/src/lanes.ts` | `review.eligible?: string[]` |
| `docs/decisions/254-eligible-sets.md` | dated Consequences note, or a new ADR |

Unchanged: inbox visibility predicate (seven copies), wake policy, sweep grace, ADR 235 hint, stakes exemption, human risk route.

## Open questions

None that block increment 1. For increment 2, one call nick already made in conversation and this spec records: **not `@team`**. If increment 1's Eval is "attention, not candidate supply," we stop rather than widening the set.

**Roles (ADR 227) as a later eligible-set refinement** — record, do not build. A designer on a web surface, a platform seat on infra, is a verdict-*quality* filter, not a latency one. No evidence yet that the quiet set's miss is the wrong *kind* of eyes. If increment 2 ships and quality is the remaining miss, reopen here.
