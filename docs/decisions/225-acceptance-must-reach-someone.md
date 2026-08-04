# 225 — Acceptance must reach someone, not merely route to them

- Status: proposed
- Date: 2026-08-04
- Deciders: nick (directed), stanley, ryder (residency-split amendment, bimodality finding, and the
  falsifier correction — from an acceptance review of this ADR)
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

**1. Acceptance actuates _reliably_, by the instrument the acceptor's state calls for.** A routed
acceptance must reach the acceptor rather than resting in an inbox — **and the right instrument
depends on whether they are live:**

| Acceptor state | Instrument                                  | Cost                |
| -------------- | ------------------------------------------- | ------------------- |
| **live**       | the ADR 088 interrupt line                  | free — already runs |
| **offline**    | a wake, with a `derivation` of its own      | ADR 131 `wake_cost` |
| **neither**    | `no_reachable_acceptor`, declared at submit | none                |

> **Amendment (2026-08-04, same day), from ryder's acceptance review of this ADR.** The first draft
> made decision 1 "emit a wake," full stop. That buys the wrong primitive for the majority case, and
> ryder's evidence is the sharpest in this document because it is the one episode where the whole
> causal chain is visible.

**The mechanism gap, verified in code.** `pendingInterrupts`
(`packages/server/src/store/messages.ts`) filters on `isUrgent(m) || m.act === 'steer'`. A routed
acceptance is `act:'ask'` with `meta {species:'approve', tier:'standard'}` and carries no urgent flag
— correctly, since urgent is `can_flag_urgent`-gated and scarce by construction. So **acceptance asks
are structurally invisible to the ADR 088 interrupt line**, which already runs on every PostToolUse
and costs nothing. The delivery rail exists, is free, and acceptance is not on it.

**ryder's four data points, 2026-08-04.** Two acceptance asks routed to them at 13:49 and 13:50
closed `review_unanswered` at 13:57 — they were live and heads-down the entire window and never saw
them. Two more routed at 14:11 and 14:13 were answered at 14:21, in 8 and 10 minutes, one of them
finding a defect. What changed between the pairs was not a wake: it was a human typing "check
messages" into their session. ryder's lifetime acceptance-wake count is zero. They are
simultaneously this ADR's 92%-reached-nobody statistic and its 36%-answered statistic, and the
delivery mechanism that worked was a person.

Buying wakes for live seats is paying ADR 131 prices for an ADR 088 problem. It also makes
`no_reachable_acceptor` a real predicate — _neither live-and-interruptible nor wakeable_ — rather
than the presence proxy this ADR was written to condemn.

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

That correction sharpens the decision rather than removing it, and combines with ryder's: the fix is
not "add wakes to a path that has none," nor "wake everyone." It is that **delivery is unconditional
on the routing while the instrument is conditional on the acceptor's state** — interrupt line when
live, wake when offline — with the wake carrying a `derivation` of its own so this question is
answerable without a join. ADR 209 already classes review wakes as portable, so that contract exists
and is applied inconsistently.

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

**Traces.** A `review`-derived `residency.wake_leased` for each acceptance routed to an _offline_
acceptor; an interrupt-line delivery record for each routed to a _live_ one, so the two instruments
are separable in the ledger rather than pooled; and a new `no_reachable_acceptor` reason on
`lane.closed`. All ride existing schemas.

**Eval — and the blended number must not be the headline.** ryder's second finding is that the
routed closes are **bimodal**, not one distribution with variance. Re-measured 2026-08-04:

| Reason                | n   | Mean time in review | Range        |
| --------------------- | --- | ------------------- | ------------ |
| `review_unanswered`   | 7   | **12.4 min**        | 6.5–20.5 min |
| `counterpart_confirm` | 19  | 62.3 min            | 1.6–423 min  |
| `review_timeout`      | 22  | **737.6 min**       | 0.1–5589 min |

A 12-minute give-up and a 12-hour give-up are not the same failure with different luck. The tight
`review_unanswered` cluster looks like ryder's 13:49 case — a live seat, asked, never told, worker
gives up fast. The 12-hour tail looks like nobody was there at all. **The original "36% answered"
pooled these two populations, which is precisely why a single primitive looked sufficient.**

So the Eval reports the answer rate **split by acceptor state at submit time** — live versus offline
— never blended. If that split does not separate the two clusters, ryder's live-vs-offline argument
collapses and the single-primitive framing was right; that check comes before the experiment is
designed, not after.

(Note also that the baseline drifts: the first draft's 16 confirms became 19 within the hour as a
human answered four pending asks. These are snapshots of a live ledger, not fixtures.)

**Early evidence, and why it is weaker than it looked.** Of the 3 acceptance asks that _did_ lease a
wake, the two identifiable ones closed `review_timeout` and `review_unanswered` — woken, and still
not answered. The first draft filed this as evidence against the ADR. It is weaker than that:
**a wake resumes a session, which is a far heavier and slower event than an in-loop interrupt.**
Against it stands ryder's n=4 in the other direction — told-while-live produced an answer in 8 and 10
minutes, twice, one finding a defect. Both are small. Neither settles anything.

The pre-registered decision rule, **restated to fix a confound in the original**: the first version
said _if routed acceptances are woken and the answer rate does not move, delivery is not the binding
constraint._ That is unsound, because a wakes-only test does not test delivery — it tests
**resumption**, and those are different claims. A wakes-only null result would have falsified
"delivery matters" when only "resumption matters" had been measured.

The corrected rule: **if acceptance is delivered by the instrument matching the acceptor's state —
interrupt line when live, wake when offline — and the answer rate still does not move, then delivery
is not the binding constraint and this ADR is wrong.** The honest response then is to make the
two-stage close advisory in name as well as in fact, not to add a further mechanism.

**Experiment.** Worth running, and it needs **three arms, not two**: control (inbox only), live-seat
interrupt-line delivery, and wake delivery. On present evidence the interrupt-line arm is both the
cheap one and the one that works, so an experiment that omits it would price the expensive primitive
against a straw control. Report the routed answer rate separately per acceptor state, per arm. The
confound to avoid is the one ADR 056 keeps hitting — do not let the arms differ in model family,
since the ladder already sorts acceptors by decorrelation grade.
