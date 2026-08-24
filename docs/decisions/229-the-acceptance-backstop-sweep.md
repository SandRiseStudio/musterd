# 229 — The acceptance backstop sweep

- Status: accepted
- Date: 2026-08-04
- Builds on: [ADR 192](192-outcome-acceptance.md) (outcome acceptance and the sanctioned self-close),
  [ADR 169](169-two-stage-close.md) (every terminal edge writes `lane.closed`; verified-ness is
  derived, never stored), [ADR 217](217-close-reason-distinguishes-a-cut-short-wait.md) (the close
  reasons this sweep must not quietly reuse), [ADR 202](202-the-verdict-moves-the-lane.md) (an accept
  closes what it accepts), [ADR 225](225-acceptance-must-reach-someone.md) (the delivery half)
- Lane: `01KZ7D582V`

## Context

A lane in `awaiting_acceptance` has no timer. `review_timeout` and its ADR 217 siblings are computed
inside `recordLaneClose` — they **label a close somebody else initiated** and never cause one. The
only reaper releases lanes owned by soft-removed seats and does not read lane state at all. So the
promised acceptance window is enforced on the **worker**, by convention (`lane_submit`'s hint says to
self-resolve on silence), and on the **system** not at all.

The consequence is not a slow lane. It is a lane with no actor left: if the worker's session ends
before it gives up waiting, nothing in musterd will ever move that lane again.

Measured on the dogfood ledger, 2026-08-04:

- **Five lanes** were found stranded in one session — `01KYN3CKJE` (#565, merged 07-31),
  `01KYX7YGNK` and `01KYX89VFB` (#570, merged 08-01), `01KYX37RKH`, and `01KYX8J5XD`.
- `01KYX8J5XD` had waited **90 hours**, unowned. Both defects it describes had been **fixed and
  merged three days earlier** (#572); it was carrying its own merge attestation the whole time.
- Close reasons to date: `review_timeout` n=22 at a **12.29h mean, 93.2h max** time-in-review, against
  `review_unanswered` n=7 at 0.21h. The fast ones are lanes whose owner was still sitting there.

**Every one of the five was finished work, not blocked work.** Nobody was stuck. Five things were
done and nothing closed them. That is what this ADR addresses: not making acceptance faster, but
giving the state machine a terminal move that does not require a live actor.

## Problem

1. A stranded lane is invisible in aggregate: it never reaches `lane.closed`, so it appears in no
   close-reason count, and the acceptance statistics are computed only over lanes that someone
   eventually closed. The worst outcomes are the ones missing from the data.
2. It is worse than invisible to its owner — it is a standing obligation with no expiry, which is
   what let five accumulate before anyone noticed the pattern.
3. The fix has an obvious failure mode, named by ryder before any of this was built: **a sweeper that
   fires early becomes the primary close path**. It would convert silence into a *timely unverified
   close* — the board looks healthier, the answer rate is untouched, and we would have automated the
   giving-up.

## Decision

### 1. A grace far above the observed close time, not the promised window

The sweep fires at **`SWEEP_GRACE_MS` = 24h** in `awaiting_acceptance`, deliberately **not** the
5-minute promise `lane_submit` makes.

This is the structural answer to problem 3, and it is chosen against the measurement rather than by
taste: 24h is **almost double the 12.29h mean time-in-review** of lanes that did eventually close. A
lane must have already outlived the typical eventual close before the sweep can touch it. The sweeper
therefore **cannot become the primary close path by construction** — it can only close what everyone
had already stopped looking at. It is not competing with acceptance; it is collecting what acceptance
has demonstrably finished with.

Deliberately not keyed on the recorded promise: only 13 of 152 closes carry a `promised_wait_ms` at
all (ADR 225's own Context, since marked provisional), so a promise-derived deadline would abstain on
91% of lanes — the sparse-field error twice over.

### 2. The system is a distinct closer, and its close is never verified

`recordLaneClose` derives `verified = done && closer.name !== ownerAtClose`. A system closer satisfies
that predicate trivially, so **the naive implementation would record every swept lane as
`counterpart_confirm`** — a genuine cross-seat review that never happened, feeding the ADR 314
diversity conclusions that read off exactly this field.

So the closer gains an explicit `kind: 'system'`, and verified-ness requires a non-system closer.
Written as a positive check, never as an absence: this is ADR 173 clause 3 in a new place, and an
auto-close that merely *fails to assert* confirmation would still be counted as one by any reader who
folds unknown into truthy.

### 3. Its own close reason

Swept closes record `reason: 'review_swept'` — not `review_timeout`. ADR 217 spent a whole increment
separating *the owner gave up early* from *nobody ever answered*; collapsing a third, categorically
different edge (**nobody was even present to give up**) into either would undo that. `closed_by`
names the system, so the ledger can always answer "did a seat decide this, or did the clock?"

### 4. Default off, per-team, on the existing loop seam

`loops.sweep: boolean`, default `false`, beside `review` and `dispatch` — the same loop-by-loop trust
ramp ADR 179 established. `parse({})` stays bit-identical to pre-229 behaviour.

### 5. The sweep never touches a waiting lane

`recordLaneClose` derives `time_in_review_ms` as `Date.now() - before.updated_at`, an approximation
that holds only while entering review is the lane's last update. A sweep that stamped lanes as it
inspected them would silently corrupt that figure for **every** close afterwards, including
human-accepted ones. The sweep therefore reads, and writes only when it closes.

## Consequences

- Protocol: `LoopsPolicy` gains `sweep`. No wire change for a team that does not set it.
- A team that arms it trades "a stranded lane waits forever" for "a stranded lane closes, unverified
  and labelled, after a day". That is a real loss of information — an acceptance that would have
  arrived on day three now lands on a closed lane — and it is the intended trade, made explicit here
  so a later reader does not have to infer it.
- The acceptance statistics get *worse-looking* and more honest at the same time: closes that were
  previously missing from the denominator start appearing, as `review_swept`.
- This is the last of the three acceptance-loop defects found on 2026-08-04, and deliberately the
  last built: delivery (ADR 225 / #651), then the accept edge (ADR 202 / #572), then this backstop.

## Observability & Evaluation

- **Traces.** `lane.closed` with `reason: 'review_swept'`, `closed_by` naming the system,
  `verified: false`, and the lane's `time_in_review_ms`. Counted like every other reason, so the
  existing `musterd report coordination` split picks it up with no new instrumentation.
- **Eval — and it is a falsifier, not a success metric.** The sweep is working when
  `review_swept` stays a **small minority of closes**. Pre-registered threshold: **if `review_swept`
  exceeds 20% of closes over any 50-close window, the sweeper has become the primary close path and
  this ADR has failed on its own terms** — the response is to raise the grace or disarm, never to
  celebrate the throughput. That is ryder's objection turned into a number that can fire.
- **Experiment.** Arm on the dogfood team only, with the five known-stranded lanes already closed by
  hand, so the first sweep fires on a lane stranded *after* this shipped. Pre-register: does the
  stranded-lane count stay at zero without the `review_swept` share crossing the threshold above?
