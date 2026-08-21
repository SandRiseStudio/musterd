# 306 — A breaker that never fired, and a chain capped by its own successes

Status: accepted 2026-08-21 (ryder; bound shape and the rejection of indefinite chaining decided by nick in-session)
Lane: 01M0K514ZY5F62FW1EDPMCK18A
Amends: [ADR 262](262-per-edge-firing-ledger.md) §4
Builds on: [ADR 199](199-dispatch-loop-wake.md) (the continuation edge), [ADR 250](250-loops-one-week-in-judgment-throughput.md) §2 and §4 item 1, [ADR 131](131-harness-residency-wake-ledger-host.md) (the per-act attempt cap)
Relates to: [ADR 253](253-non-risky-lanes-never-ask-a-human.md)

> **A note on a citation, since this ADR amends the one carrying it.** ADR 262's *Relates to* line
> glosses ADR 247 as "progress is not an outcome". ADR 247 is *"A documented discard is a
> precondition on every consumer"*, and is still `proposed`. The doctrine §2 below rests on is
> ADR 250 §2, quoted verbatim; nothing here needs ADR 247, and the gloss is not repeated.

## Problem

ADR 262 shipped the ADR 250 §4 item 1 breaker on 2026-08-13. Measured against the live dogfood
ledger on 2026-08-21, **it has never fired**, and the check that fires instead is breaking the
guarantee ADR 262 §4.1 wrote down.

Two guards run in sequence on every work-order candidate, both with threshold 3:

| | key | counts | order |
| --- | --- | --- | --- |
| `attemptsForAct` (ADR 131) | `act_id`, else `lane:<id>` | `residency.woke` **and** `wake_failed` | first |
| ADR 262 edge breaker | `(lane_id, edge)` | `wake_failed` only | second |

The second counts a strict **subset** of the first's rows, at an **equal** threshold, on a **finer**
key. A counter so placed is nearly unreachable, and for continuation candidates — which carry no
`act_id`, so `wakeExhaustionKey` falls back to `lane:<id>` — it is unreachable in principle: any
count of failures on `(lane, edge)` is bounded above by the count on `lane:`, which stopped the
candidate one check earlier.

The ledger agrees, exactly:

- **Zero** `residency.wake_exhausted` rows carry `detail.breaker: true`, in eight days.
- **Five** distinct `(lane, edge)` pairs reached 3 failures — the breaker's threshold. All five
  were stopped by the per-act cap instead (`attempts: 3`, no breaker flag).
- **Nothing** in the ledger exceeds 3 attempts on any key.

The harm is not the dead code. It is that the surviving guard counts **successes** toward a
**lifetime** terminal row (`isExhausted` writes one per key, ever). So:

> `lane:01M040DH9X52BJP0VXNZ7CQR6K` and `lane:01KZ4QH585V576F3NTD9R30RXZ` each have **3 wokes and 0
> failures**, and neither can ever be woken on its continuation edge again.

That is precisely the case ADR 262 §4.1 promised would keep working: *"Three successful continuation
wakes on the same claimed lane must still derive — that edge is the chaining primitive (ADR 199)."*
It is false in production, and has been since the day ADR 262 landed.

**The test that existed to catch this was configured out of it.** `residency.test.ts`'s "three woke
on dispatch_continuation still derive" enrolls with `attempt_cap: 10`. Production runs the ADR 131
default of 3. The test passes, the guarantee fails, and nothing connects the two.

One further fact constrains the fix: `dueDispatchContinuationWorkOrders` has **no memory at all** —
it re-derives a candidate for every claimed/active owned lane on every poll, forever. The lane-keyed
cap of 3 is currently the *only* thing bounding continuation spend, so it cannot simply be deleted.

## Decision

For an **edge-bearing work-order candidate** (`edge !== null` with a `lane_id`), the ADR 262
`(lane, edge)` rules are the complete bound. The per-act attempt cap and its terminal exhaustion row
do not apply. Inbox wakes (`edge = NULL`) are untouched — there a success *should* retire the act,
or a delivered doorbell rings forever.

### 1. Successes stop buying exhaustion

Failure is bounded by the ADR 262 breaker (`WORK_ORDER_EDGE_BREAKER_N = 3` `wake_failed` rows on the
edge), which now actually reaches its own check. A `residency.woke` never counts toward a terminal
state for a work order.

### 2. A continuation wake that moved nothing does not buy the next one

No continuation wake derives for a lane whose `lanes.updated_at` has not advanced since the last
`residency.woke` on that `(lane, edge)`. No prior woke means nothing to have stalled since, so the
first firing is always permitted. This is ADR 250 §2's restated doctrine — *no heartbeat that burns
spend while nothing changed*.

The skip is silent, like the still-true skip: a stalled lane is the normal resting state of a
claimed board, not an event worth an audit row on every poll.

**This narrows ADR 262 §4.1** rather than restoring it verbatim. The guarantee now reads: three
successful continuation wakes still derive, *provided each one moved the lane*. A seat that wakes and
changes nothing is not entitled to another session, and the amended test says so.

### 3. A succeeding chain has a ceiling too

`WORK_ORDER_CONTINUATION_SUCCESS_CAP = 8` successful wakes per `(lane, edge)`. Past it the candidate
is skipped and the trip is recorded as `residency.wake_exhausted` with `detail.reason:
'continuation_cap'` — a counted event on a verb that already exists. It raises no human ask
(ADR 253).

Indefinite chaining was considered and **rejected by nick in-session**. §2 alone bounds a *stalled*
chain but not a *productive-looking* one, and a seat that keeps touching a lane without finishing it
would spend without limit.

**The number 8 is a judgment, not a measurement, and the ledger cannot currently improve it.** Every
chain in the corpus was truncated at three by the very cap this ADR removes, so the observation is
**censored**: no lane was ever permitted to run longer, and the data cannot say what a healthy chain
costs. Eight sits comfortably above the three that provably strangles real chains and low enough that
a runaway costs single-digit sessions. It lands as a named constant carrying that reasoning, its trip
is counted so the first real one is visible, and it is re-measured once trips exist.

Deliberately **not** a residency policy knob. ADR 185's sparse policy would support one, but a knob
nobody can calibrate is worse than a constant that says why it is what it is.

### 4. Not done here

The two lanes already carrying terminal exhaustion rows are **not** revived by a ledger edit. They
recover on their own, because §1 stops consulting `isExhausted` for edge-bearing work orders — the
rows stay in the audit log as the historical record of the defect, which is the honest outcome: the
ledger is append-only and the fix is in what reads it, not in what it says.

`REVIEW_LOOP_BREAKER_N` stays in `review.ts`, untouched (ADR 262 §6). Inbox / `immediate` /
`batched` wake semantics do not move. The merge loop, capability fitness, and acceptance absorption
(ADR 250 items 2–4) remain out of scope.

## Consequences

- Continuation chaining works again, bounded by *8 successes + 3 failures* per `(lane, edge)` rather
  than by a flat 3-of-anything that counted successes as damage.
- The ADR 262 breaker becomes reachable, so its own eval — "breaker trips are a counted event, not a
  silent skip" — can be evaluated for the first time.
- A stalled claimed lane stops generating spend entirely, which is a reduction against today.
- Worst-case spend per lane-edge rises from 3 to 11 sessions. That is the deliberate price of
  chaining, and the ceiling is now explicit and counted rather than implicit and wrong.
- Two guards whose thresholds must not be compared casually are now separated by role: one bounds
  failure, one bounds success. The general trap is recorded below.

## The general trap

**A subset counter behind a superset counter at an equal threshold is dead code.** It reads as a
second line of defence and is in fact unreachable, and nothing in the audit log distinguishes "this
guard is working" from "this guard has never once run" — both look like an absence of trips. That is
the fourth instance this week of one shape: *a check that cannot separate two causes will confidently
report the wrong one.* Here the two causes were success and failure, counted into one number.

The tell was cheap and available the whole time: the guard's own trip is a distinguishable audit row,
and nobody had ever queried for one.

## Observability & Evaluation

**Traces.** The ADR 262 breaker trip (`residency.wake_exhausted` + `detail.breaker: true`) is
unchanged and now reachable. The new trip is the same verb with `detail.reason: 'continuation_cap'`
plus `detail.edge` and `detail.lane_id`. The §2 stall skip writes nothing by design; it is observed
as the *absence* of `residency.wake_leased` rows on a lane whose `updated_at` is older than its last
`residency.woke`, which is queryable from rows that already exist.

**Eval.** Baseline, measured 2026-08-21 on the dogfood daemon: 0 breaker trips in 8 days; 5
`(lane, edge)` pairs at the 3-failure threshold; max 3 attempts on any key; 2 lanes terminally
exhausted at 3 wokes / 0 failures. Success at one week: continuation chains of length > 3 exist in
the ledger (proving §1 landed); at least one `breaker: true` row appears if any edge still fails
three times; `continuation_cap` trips are countable. Failure signal: `continuation_cap` trips are
*common*, which would mean 8 is too low or that chains are not terminating on their own — either
way it amends this ADR rather than being tuned quietly.

**Experiment.** The control is the inbox path: its wake repeats must not move, because §1 excludes
it by construction. The measurement is the same query that found the defect — attempts per
`(lane, edge)` and per `lane:` key, before and after — and the disproof of §1 is any lane reaching a
terminal exhaustion row on a count that includes a `residency.woke`.

**Snapshot-debt:** none. Every count above is exact, dated 2026-08-21, and drawn from the live
ledger; `WORK_ORDER_CONTINUATION_SUCCESS_CAP = 8` is declared a judgment under censored data rather
than a measured rate, and §3 states the condition that revises it.
