# 217 — A close reason distinguishes a cut-short wait from a real silence

- Status: accepted
- Date: 2026-08-03
- Builds on: [ADR 192](192-outcome-acceptance.md) (outcome acceptance; the owner self-resolves on
  silence), [ADR 169](169-two-stage-close.md) (close reasons are derived, never stored),
  [ADR 173](173-absent-is-not-unknown.md) (an abstention must be countable),
  [ADR 147](147-human-ask-stream.md) (ask tiers grade the wait by consequence)
- Prompted by: lane `01KYZATZ6M22MD9YT5J7E8MVHM` — re-measured 2026-08-03, which **falsified the
  lane's own premise**

## Context

The lane that prompted this ADR asserted that `review_timeout` was the largest close failure and
that "the 5-minute acceptance window is a human clock imposed on async agents." Re-measuring on
2026-08-03 against the live audit ledger refuted both halves.

**There is no acceptance window.** No timer, no auto-close, no constant. ADR 192 teaches
`merge → lane_submit → wait for acceptor → self-resolve only on silence`: the **owner** decides when
silence has lasted long enough. All 18 `review_timeout` rows in the ledger were closed by the lane's
own owner. The "5 minutes" was ADR 147's `standard` **ask tier** (`ask.ts`), which governs an ask's
no-answer contract — not lane close.

**And `review_timeout` never measured a timeout.** The reason is derived purely from state: the lane
passed through `awaiting_acceptance`, the closer was the owner, routing was not `false`. No elapsed
time is consulted. Measured over every such row:

| time actually in review | closes |
| ----------------------- | ------ |
| under 1 min             | 4      |
| 1–5 min                 | 7      |
| over 5 min              | 7      |

**11 of 18 closed before five minutes had passed at all.** The fastest was **8 seconds**.
`musterd report review` prints every one of them as "asked, unanswered."

The real finding sits underneath, and it is sharper than the lane's:

- successful confirms take a **median of 22 minutes** (mean 95 min, max 7 h 3 m)
- owners give up after a **mean of 6.4 minutes**
- **9 of 11 confirms landed later than the average owner waits**; only two ever arrived inside six
  minutes

So the acceptance loop is not failing because reviewers ignore asks. It is failing because owners
abandon the wait 3–20× sooner than a real answer takes to arrive — and the ledger records that
impatience under a label asserting the opposite.

## Problem

One reason spans two opposite failures and asserts the wrong one about both:

- the owner **honoured** the wait it promised the acceptor and met genuine silence, and
- the owner **cut the wait short**, sometimes in seconds, and closed unconfirmed anyway.

A reader — human or the `report review` counter-metric — cannot tell them apart, and the label
tells them the first happened. Any remedy aimed at the second (a longer window, a reachability gate,
a late verdict) is unmeasurable while both wear the same badge.

## Decision

**1. The ready row records the wait that was promised.** When the daemon composes the acceptance ask
it already picks a tier (`standard` for a peer acceptance, `blocking` for a required-human or
loop-breaker ask). `lane.ready_for_review` now persists that tier and its `timeout_ms` as
`ask_tier` / `ask_timeout_ms`. Nothing new is invented: the promise is the one ADR 147 already
attached to the ask.

**2. The close edge splits the reason against that promise.** `recordLaneClose` compares
`time_in_review_ms` to the promised window and derives:

| reason              | meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `review_unanswered` | the owner waited **at least** the promised window; the silence is real |
| `review_cut_short`  | the owner closed **before** the window it promised the acceptor        |
| `review_timeout`    | **abstains** — the promised window is not knowable for this lane       |

**3. `review_timeout` becomes the abstention, not the assertion.** Every existing row literally
carries that label and history is not rewritten (ADR 169). A close whose ready row predates clause 1
keeps `review_timeout`, which now reads "entered review, owner closed, and we cannot tell whether
the promised wait elapsed" — a countable unknown in the ADR 173 sense, never a verdict about a past
that recorded none.

**4. The never-a-wedge property is untouched.** Nothing blocks, nothing waits, no close is refused
and no timer is introduced. An owner may still close at 8 seconds; the ledger simply stops calling
that a timeout. ADR 145's degradation is load-bearing and survives verbatim.

## Consequences

- `report review` gains two lines where it had one, and its "asked, unanswered" copy becomes true of
  the row it labels.
- `ReviewMetrics.closed` gains `review_unanswered` and `review_cut_short`; `review_timeout` stays in
  the schema as the abstention bucket. A backward-compatible addition — an older reader that knows
  only `review_timeout` sees the abstentions and folds the rest into `unknown_reason`, which is
  already an explicit bucket.
- **The split is forward-looking.** Every row in the ledger today abstains, because no ready row
  recorded a promised window before this ADR. The metric starts empty and fills as lanes close. That
  is the honest shape and the reason clause 3 exists.
- **Known limit — `time_in_review_ms` is an approximation.** It measures from the lane's last update
  before the close, which ADR 169 already notes is _usually_ the ready edge. A `lane_update` during
  review resets it, biasing that lane toward `review_cut_short`. Closing this would require the ready
  edge to stamp its own timestamp; deliberately not done here, because the bias is small and always
  in the direction of flagging impatience that may not exist — never of hiding it.
- This ADR deliberately does **not** change how long anyone waits. Grading the window by consequence,
  reachability-gating the timeout, and letting a late verdict upgrade a close are the three remedies
  the lane weighed; all three are now _measurable_ and none is decided here.

## Observability & Evaluation

**Traces.** `lane.ready_for_review.detail` gains `ask_tier` and `ask_timeout_ms` — the promise, written
where the tier is decided. `lane.closed.detail` carries the split reason plus `promised_wait_ms` on
every row that could be graded, so the derivation is auditable from the close row alone, without
re-reading a ready edge whose roster has since moved on. `time_in_review_ms` is unchanged and remains
the measured side of the comparison.

**Eval.** `musterd report review` reports the buckets separately; the dataset is the `lane.closed`
ledger, queryable by `json_extract(detail,'$.reason')`.

- **Baseline (measured 2026-08-03, the whole ledger — 18 review closes):** `review_cut_short` would
  have been **11 of 18 (61%)**, `review_unanswered` 7 (39%), against a median successful confirm of
  **22 minutes** and a mean owner give-up of **6.4 minutes**.
- **Success:** within 14 days of the first post-ADR close, both new buckets are non-zero — the split
  discriminates rather than collapsing onto one side.
- **Falsifier:** if `review_timeout` is still dominant 14 days on, clause 1 is not firing on the paths
  that matter and the ready row is not being written where this ADR assumes it is.

**Experiment.** The remedy this measurement invites — lengthening or reachability-gating the wait —
is deliberately not bundled here, so it can be run as a real before/after against this ADR's
baseline: hold everything else fixed, change the promised window, and read the `review_cut_short`
share. Bundling the fix with its own instrument would have left nothing to compare against.

**Re-measure; do not trust this ADR's numbers.** They come from 18 review closes over six days on a
single team, and ADR 202 (the verdict actually moving the lane) landed 2026-08-01 — two days before
this measurement. There is no established steady state to defend.
