# 225 — Acceptance must reach someone, not merely route to them

- Status: proposed
- Date: 2026-08-04
- Deciders: nick (directed), stanley
- Amends: [ADR 192](192-outcome-acceptance.md) (the acceptor's job and the two-stage close stand
  unchanged; this ADR changes how the ask is delivered and what is promised for it) and
  [ADR 188](188-graded-review-ladder.md) (the grading ladder is untouched)
- Follows: [ADR 153](153-reachability-gated-hold.md), which solved the same shape for to-human asks

## Context

ADR 169 split the close into worker claim and counterpart claim. ADR 192 renamed the stage and gave
the acceptor a real brief. Neither has produced acceptance at any rate.

**Baseline, from the `lane.closed` audit ledger, all 146 recorded closes:**

| Reason                | Closes | Share |
| --------------------- | ------ | ----- |
| `self_close`          | 71     | 49%   |
| `no_candidate`        | 31     | 21%   |
| `review_timeout`      | 22     | 15%   |
| `counterpart_confirm` | **16** | 11%   |
| `review_unanswered`   | 5      | 3%    |
| `review_cut_short`    | 1      | <1%   |

**89% of closes are unverified.** Of the 44 that were actually routed to an acceptor, 16 were
confirmed — a **36% answer rate**. In the last 30 days the split is 16 verified against 130 not.

Two numbers say more than the totals:

- **A successful acceptance takes a mean of 73 minutes** (max 7.1h) against a `promised_wait_ms` of
  **300,000 — five minutes.** The promise is not merely missed by the failures; it is contradicted
  by the _successes_. Every confirmed acceptance in the ledger arrived after the window it was
  promised in had closed.
- **A timed-out acceptance sits a mean of 12.3 hours**, max **93.2 hours** — nearly four days.

Acceptance is not distributed thinly across the roster either; the confirms that do happen come from
six different seats, so this is not one bad actor. It is the mechanism.

## Problem

The routing is already presence-gated. `pickReviewer` filters candidates through `hasLivePresence`
before the ADR 188 ladder ever runs, so an acceptor is only chosen if a live session exists. On
2026-08-04 gptbot was picked for lane `01KZ75AXZK` on exactly that basis, was live throughout, was
pinged directly, and never answered; the lane closed `review_unanswered` after 20 minutes.

So the defect is not candidate selection. It is that **presence is being used as a proxy for
reachability, and it is not one.** A live session means a process exists. It does not mean anything
will tell that session an obligation is waiting. The acceptance ask lands in an inbox and waits for
the acceptor to voluntarily look — and a heads-down seat's next look is, per the ledger, over an
hour away and frequently never.

This is the same error ADR 155 named for the ask clock (presence informs the clock, never the
ceiling) and ADR 221 named for deferrals (a status line is too passive a surface to carry an
obligation). Acceptance is the third instance and the worst-measured.

Three failures hide inside the one statistic, and they need different fixes:

1. **`self_close` (71)** — the worker never submitted at all. An adoption failure. ADR 192 already
   spent a vocabulary change on it; this ADR does not spend another.
2. **`no_candidate` (31)** — the ladder found nobody eligible. A staffing and decorrelation problem,
   partly by design (ADR 188 refuses same-model review, correctly).
3. **routed-but-unanswered (27)** — the subject of this ADR. Someone was picked, and nothing reached
   them.

## Decision

**1. Acceptance actuates _reliably_.** A routed acceptance must emit a wake for the acceptor rather
than resting in an inbox.

> **Correction (2026-08-04, same day).** The first draft of this ADR said the wake ledger contained
> "no `review`-derived wake in its entire history." That was **wrong**, and dolly's ADR 199 Eval
> re-measurement caught it: acceptance wakes do not carry a distinguishing `derivation`, so they hide
> inside the `work_order` bucket, and reading the `derivation` column alone missed them. Joining the
> lease back to the act that caused it — the test dolly argues for — gives the real number.

The real number is worse than a clean zero and better evidence for this ADR. Of **38 acceptance asks
in the ledger, 3 produced a wake and 35 did not** — 92% reached nobody. Acceptance wakes exist and
fire occasionally; what does not exist is any guarantee that routing one wakes anyone. The
concrete instance is this ADR's own origin: lane `01KZ75AXZK`'s acceptance ask to gptbot (13:00:57)
leased **zero** wakes, which is why a live, pinged acceptor never answered.

That correction sharpens the decision rather than removing it. The fix is not "add wakes to a path
that has none"; it is "make the wake unconditional on the routing, and give it a derivation of its
own so this question is answerable without a join." ADR 209 already classes review wakes as
portable, so the contract exists and is applied inconsistently.

**2. The promise matches the measurement.** `promised_wait_ms` of five minutes is falsified by every
successful acceptance in the ledger. The submit-time promise must be set from the measured
distribution, not from a round number — and the honest shape is not a short synchronous wait at all.
Acceptance is asynchronous: the worker should be told so plainly at submit, and should never be
implicitly encouraged to burn a dead five minutes before self-closing.

**3. Unreachable is a first-class outcome, declared at submit.** When no acceptor can be _reached_ —
as against merely being present — say so at `lane_submit`, with a distinct reason
(`no_reachable_acceptor`), instead of routing into silence and letting the worker discover it via
timeout. This is ADR 153's `ask.stranded` applied to acceptance: an obligation nobody can receive
should be recorded as such immediately, not converted into a wait that will fail.

**4. An unconfirmed close stays legitimate, and stays visible.** Nothing here makes self-closing
wrong; with no reachable acceptor it is the correct action, and today's practice of closing
unconfirmed with a stated verification is good practice, not a workaround. What changes is that the
ledger will distinguish _nobody could be reached_ from _someone was asked and did not answer_, which
today both collapse into an unverified close.

## Consequences

- Acceptance costs wakes, and wakes cost money (ADR 131's `wake_cost`). This is the real price of the
  decision and it should be judged as such: at current volume it is a small number of wakes per day,
  but it converts acceptance from free-and-ignored to paid-and-delivered.
- A seat that is woken for acceptance is interrupted for someone else's work. ADR 199's budget and
  cooldown rules apply unchanged; acceptance does not get a privileged lane.
- Setting the promise from data will make the promise look worse — an hour rather than five minutes.
  That is the point: it is already an hour, and only the promise disagrees.
- `no_reachable_acceptor` will absorb some of what is currently `no_candidate` and some of what is
  currently `review_timeout`, so the three-way split will shift. The historical strings are not
  rewritten (ADR 173 posture); the new reason applies going forward only.

## Observability & Evaluation

**Traces.** A `review`-derived `residency.wake_leased` for each routed acceptance, and a new
`no_reachable_acceptor` reason on `lane.closed`. Both ride existing schemas.

**Eval.** The measurable claim is that acceptance rises because the ask arrives. Baseline is stated
above and is unusually well-recorded: **16 of 146 closes verified (11%); 16 of 44 routed acceptances
answered (36%); confirms at a 73-minute mean against a 5-minute promise; timeouts at a 12.3-hour
mean.** Success is the routed answer rate rising materially above 36% and the confirm latency falling
toward the promise once the promise is honest.

**Early evidence against this ADR, recorded because it exists.** Of the 3 acceptance asks that _did_
lease a wake, the two whose lanes can be identified closed `review_timeout` and `review_unanswered`
respectively — woken, and still not answered. That is n=2 and proves nothing on its own, but it
points squarely at the falsifier below rather than away from it, and anyone running this Eval should
start from the possibility that delivery is not the binding constraint.

The pre-registered decision rule, stated now: **if routed acceptances are woken and the answer rate
does not move, the problem is not delivery and this ADR is wrong.** In that case the conclusion is
that acceptance is not valued by the seats being asked — and the honest response is to make the
two-stage close advisory in name as well as in fact, not to add a third delivery mechanism. A rise in
answer rate with a rise in `wake_cost` is the expected outcome and is a trade to be judged on the
numbers, not a failure.

**Experiment.** Worth running, unlike the recent ADRs. Acceptance wakes can be enabled per-team, and
the roster is large enough to hold an arm back: seats on the control arm keep inbox-only delivery
while the treatment arm wakes. The measurement is the routed answer rate, and the confound to avoid
is the one ADR 056 keeps hitting — do not let the arms differ in model family, since the ladder
already sorts acceptors by decorrelation grade.
