# 225 — Acceptance must reach someone, not merely route to them

- Status: proposed
- Date: 2026-08-04
- Deciders: nick (directed), stanley, ryder (residency-split amendment, bimodality finding, the
  falsifier correction, and raising the shared-predicate trap — from an acceptance review of this
  ADR), dolly (the `derivation` re-measurement that forced the wake-count correction, and the call
  that the shared-predicate trap is a pattern rather than three incidents)
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

**The crossed handoff — the strongest datum here, and it was pre-registered.** When ryder handed the
follow-up lane to stanley at 14:41:45, they stated the test in the message before the outcome was
known: _"you are online and this handoff leased ZERO wakes, so it depends on you to voluntarily look.
If you read this promptly, that is evidence against the lane. If nick has to poke you, that is n=5."_

It was n=5. The handoff sat **13 minutes 26 seconds** unread. stanley was live and working
throughout — merging [#646] and writing seat memory inside that window — and read it only when a
human typed "check messages." The author of this ADR failed to receive a handoff about this ADR's
own delivery gap.

What makes it the strongest datum is not the latency but what the latency caused. **At 14:53:06,
still not having seen ryder's handoff, stanley handed the same lane back to ryder.** Two seats, one
lane, twelve minutes, both acting in good faith on an inbox neither had read since before the other
acted:

| Time         | Event                                               |
| ------------ | --------------------------------------------------- |
| **14:41:45** | ryder hands lane `01KZ7B090Z` → stanley             |
| **14:53:06** | stanley, not having seen it, hands the same → ryder |
| **14:55:11** | stanley reads the 14:41 handoff, after a human poke |

**No wake would have prevented this.** Both seats were alive the entire time; there was nothing to
wake. This is the live-seat delivery hole producing not silence but **contradiction** — two seats
issuing opposing decisions about one lane — which is a materially worse failure than an acceptance
going unanswered, and one that residency-based delivery cannot address even in principle.

[#646]: https://github.com/SandRiseStudio/musterd/pull/646

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

> **Amendment (2026-08-04, same day): "live" in this table is two conditions, and the gap between
> them is a real population.** Found while checking a live episode of this ADR's own subject matter,
> and it is the ADR's thesis recursing one level up — _presence is not reachability_ applied to
> **instrument selection** rather than to routing.
>
> Routing eligibility is `hasLivePresence` (`store/presence.ts`): a presence row whose `last_seen_at`
> heartbeat is fresh. Interrupt-line delivery is `GET /inbox/interrupt-check`, which by its own
> contract is _"a PostToolUse hook [that] runs at every tool boundary."_ A connection heartbeats while
> **idle**; the hook fires only while the seat is **executing tool calls**. These are not the same
> condition, and the difference is not academic:
>
> | Acceptor                        | Routed as | Interrupt line reaches it?                             | Wake?                       |
> | ------------------------------- | --------- | ------------------------------------------------------ | --------------------------- |
> | live **and in a tool loop**     | live      | yes, at the next tool boundary                         | not needed                  |
> | live **but idle between turns** | live      | **only when the seat next acts, which nothing bounds** | **no — it is classed live** |
> | **woken for another ask**       | offline   | n/a — the session exists but serves one act            | **already spent**           |
> | offline                         | offline   | no                                                     | yes                         |
>
> **The third row is dolly's, found 2026-08-04, and it is the wake rail's version of the second.**
> Her acceptance ask for `01KZ7D582V` was routed to gptbot at 16:51:25. gptbot then woke at
> 16:58:00 — but for _this ADR's own_ lane `01KZ7JAT55`, a different ask that arrived **later**. It
> reviewed that one, accepted at 16:59:53, and went offline. Her ask sat in the same inbox for the
> entire ~2 minutes the session existed, six minutes older than the wake that raised it, and was
> never touched. **One wake serves one ask:** the woken session treats its wake payload as the whole
> job, so inbox depth at wake time is invisible to it. The seat was present, capable, and
> structurally unaware of the rest of its queue — which is neither a delivery failure nor an
> attention failure, and no amount of delivery fixes it. The cheap remedy is a payload change, not a
> delivery one: let the wake composition say _"and N older asks are waiting."_ It costs no extra wake.

> The middle row is routed to the free rail, cannot be promptly reached by it, and is disqualified
> from the paid one _because it looks live_. It is not permanently unreachable — the hook fires
> whenever the seat resumes — but the latency is bounded by **the acceptor's own next action**, which
> is exactly the "wait for them to voluntarily look" failure this ADR was written to end. So #651
> does not make delivery unconditional as decision 1 promises; it makes it conditional on the
> acceptor doing something first. That is a weaker defect than the original, and the same shape.
>
> This does not retract decision 1 — the interrupt line is still the right free instrument for a
> working seat, and it is still strictly better than an inbox. It means the live/offline split is
> **under-specified**, and the honest three-way is _interruptible_ / _wakeable_ / _neither_, with
> `no_reachable_acceptor` widening to cover an idle-live seat that nothing may reach in time. Sizing
> the middle row is a measurement, not a guess, and it is now the first thing the Eval should report.

**2. The promise matches the measurement.** — **WEAKENED, do not implement on this evidence.** See
"What this ADR's evidence is actually worth": where a promise is actually recorded, confirms land at
6.7 min against a 5.0-min promise. The claim below averaged pre-ADR-217 rows that record no promise
at all, and does not survive.

~~`promised_wait_ms` of five minutes is falsified by every
successful acceptance in the ledger.~~ The submit-time promise must be set from the measured
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

## The shared-predicate trap

Raised by ryder; identified as a pattern rather than three incidents by dolly, whose call it is —
the same skeleton appeared four times on 2026-08-04, three of them inside this ADR's own review.

> **One value, two consumers, opposite needs — and the second consumer is invisible from the first's
> call site.**

It earns a section here rather than an ADR of its own because the third instance _is this ADR's
thesis_. Decision 1 says live and offline acceptors want different instruments. ryder found the same
claim already latent in the code as a defect: one predicate was being asked to serve a free rail and
a paid one. The conflation this ADR argues against was not hypothetical; it was shipped, and the
implementation of the fix is where it surfaced.

| Value               | First consumer (writes / assumes)                         | Second consumer (reads, needs otherwise)                                                            | What broke                                                                                | Found by                |
| ------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| `derivation`        | wake-lease creation, an incidental label                  | the ADR 199 Eval, measuring by _originating act_                                                    | acceptance wakes hid in the `work_order` bucket → "no review-derived wake ever" was false | dolly (ADR 199)         |
| `promised_wait_ms`  | ADR 217 `laneClose`, recorded only when knowable          | this ADR's aggregate, which read it as universal                                                    | present on 13 of 152 rows → the 73-min-vs-5-min headline collapsed                        | stanley ([#646])        |
| `pendingInterrupts` | the ADR 088 interrupt line — **free**, live seat, opts in | `claimWakeLeases` — **paid** (ADR 131 `wake_cost`), gated on `loops.review` + `flow:auto` (ADR 191) | admitting obligations routed a paid wake around its own policy gate                       | ryder ([#651])          |
| seat roles          | `serialize.ts:55`, db → files, writes singular `role`     | `reconcile.ts:163` + `seatfile.ts:110`, which treat plural `roles` as authoritative                 | db → files → db silently demotes a multi-role seat to its first role                      | stanley (ADR 227 inc 1) |

**The tell, and why review keeps missing it.** In every case the first consumer's code is correct in
isolation and reads as complete at its call site. `memberRowToSeat` writing `{ kind, role }` is not
obviously wrong until you know that a different module treats a field it never mentions as
authoritative. The second consumer is not merely elsewhere in the file — it is elsewhere in the
system, reached by a path the first author had no reason to open. Positive tests exercise the first
consumer's case and stay green, because the first consumer's case is the one everybody had in mind.

**The check** — the first clause was already in this document, from the two errors above; the second
is the half that was missing:

> _What wrote this row, and **who else reads it**?_

**A guard that never instantiates the second consumer's case is decoration.** This is the sharpest
part, and it comes from the fourth instance, where the first three's saving grace is absent. In
instances 1–3 the negative tests caught it: ryder's first cut turned four tests red precisely because
the paid rail had its own assertions. In instance 4 there is no negative test at all — and, worse,
there is a guard that looks like one. `reconcile.test.ts:232` is named
_"projects per-seat capabilities so db → files → db is a fixed point"_: exactly the invariant that
multi-role seats violate. It passes because its fixture is two single-role seats (`boss` with
`role = "lead"`, `quiet` with `role = ""`). Every multi-role test in the file runs files → db, the
direction that does not lose data. So the guard is well-named, well-intentioned, and **will be green
for the entire life of the bug.** A round-trip guard proves nothing about a field its fixture never
populates.

**Corollary from ryder's fix: widening a predicate makes its key a capability.** Once
`pendingInterrupts` admits an obligation class, whatever field selects that class decides who can
raise another seat's interrupt line — so `meta.lane_review` had to become server-controlled
(`route.ts:171` strips it from any envelope the daemon did not compose). Keyed on act+tier alone, any
seat could have minted an interrupt and routed around `can_flag_urgent`, which is the very gate that
keeps the line scarce. **The new admission key inherits the trust requirements of the rail it opens.**

**What this implies for decision 1, and it is a caution against the obvious reading.** The remedy is
_not_ to widen the shared predicate until it satisfies everyone. It is to make the second consumer
explicit and let each rail state its own need — which is what shipped: `obligations` is opt-in and
**off by default**, the free rail passes `{ obligations: true }` (`http.ts:3000`), and
`claimWakeLeases` calls the same function bare (`residency.ts:717`) so the paid rail keeps its gate.
One predicate, two call sites, opposite defaults, each legible where it is used. Applied to instance
4, the equivalent fix is for the exporter to emit what the reader treats as authoritative — not for
the reader to start guessing from the singular field.

### The sibling: a fixture more convenient than production

dolly's, 2026-08-05, correcting her own shipped work, and it belongs beside the trap because it is
how the trap survives a test suite. [#653]'s fix went green and did not fix the instance it cited.
The real message carried no `meta.lane_handoff.lane`, so the code abstained and served the stale
handoff exactly as before — but the test reproduced the staleness with a **synthetic handoff that
did carry the lane meta**, so the assertion passed while the real case stayed broken. She caught it
only by re-running the live query instead of trusting the suite.

**A fixture more convenient than production makes a green test evidence of nothing.** This is the
shared-predicate trap's test-time twin: the trap is a second consumer whose case the first never
considered, and the fixture sibling is that second consumer's case never being _instantiated_. Both
have the same remedy and it is one sentence — **the second consumer's case must be instantiated, in
the fixture and in the assertion, or the guard is decoration.**

It generalizes past that one PR. Instance 4's single-role fixture is the same defect; so, arguably,
is why `interrupts.test` additions passed while `claimWakeLeases` broke, since the negative case
lived in a different suite. And it is directly relevant to this ADR's own conduct: every retracted
claim here came from reading an aggregate without asking what wrote the row. A convenient fixture is
that error moved one level up — reading a number you constructed to be readable.

dolly's own framing is the one to keep, because she applied it against herself: _"the number and the
behaviour looked like X and nobody asked what produced it."_

[#653]: https://github.com/SandRiseStudio/musterd/pull/653
[#651]: https://github.com/SandRiseStudio/musterd/pull/651

## Observability & Evaluation

**Traces.** A `review`-derived `residency.wake_leased` for each acceptance routed to an _offline_
acceptor; an interrupt-line delivery record for each routed to a _live_ one, so the two instruments
are separable in the ledger rather than pooled; and a new `no_reachable_acceptor` reason on
`lane.closed`. All ride existing schemas.

> **Retraction (2026-08-04, same day).** The bimodality argument below is **withdrawn**. ryder
> retracted it and I confirmed the retraction: `review_timeout` and `review_unanswered` are not two
> acceptor populations, they are two **labelling epochs**. All 22 `review_timeout` rows carry a NULL
> `promised_wait_ms` and span 07-28→08-04; all 7 `review_unanswered` rows carry one and fall on
> 08-04 alone. ADR 217 had already made this split: `laneClose.ts` emits `review_timeout` as the
> **abstaining** label when `promised_ms` or `time_in_review` is unknowable. So the contrast is a
> week of pre-217 abstentions against one day of post-217 measurement — it says nothing about
> acceptor state. The table is kept below, struck, because the error is more instructive than its
> absence. See "What this ADR's evidence is actually worth."

**~~Eval — the blended number must not be the headline.~~ ~~ryder's second finding is that the
routed closes are bimodal, not one distribution with variance.~~** ~~Re-measured 2026-08-04:~~

| Reason                | n   | Mean time in review | Range        |
| --------------------- | --- | ------------------- | ------------ |
| `review_unanswered`   | 7   | **12.4 min**        | 6.5–20.5 min |
| `counterpart_confirm` | 19  | 62.3 min            | 1.6–423 min  |
| `review_timeout`      | 22  | **737.6 min**       | 0.1–5589 min |

**What this ADR's evidence is actually worth.**

Chasing the retraction above showed the same flaw runs deeper, and it takes a second headline claim
with it. **Only 13 of 152 recorded closes carry a `promised_wait_ms` at all** — the rest predate
ADR 217 and abstain. Split the confirms on that line:

| Confirms                    | n   | Mean time in review | Mean promise |
| --------------------------- | --- | ------------------- | ------------ |
| **with** a recorded promise | 5   | **6.7 min**         | **5.0 min**  |
| without one (pre-217)       | 14  | 83.7 min            | —            |

So the original claim — _"a successful acceptance takes 73 minutes against a five-minute promise; the
promise is contradicted by its own successes"_ — is **false**. It averaged 14 rows that never
recorded a promise together with 5 that did. Where the promise is actually measured, acceptance
lands at **6.7 minutes against a 5.0-minute promise**: modestly over, essentially honest. Decision 2
below is therefore substantially weakened and should not be implemented on this evidence.

**The honest position.** This ADR's Context table is a week of mostly pre-217 rows whose labels no
longer mean what the current code makes them mean. Every aggregate in it should be read as
provisional until re-measured over the post-217 window, which is currently n=13 — too small to
conclude anything.

**The evidence that is actually strong is the pre-registered kind.** Every retracted claim above came
from reading aggregates after the fact. The crossed handoff did not: ryder named both possible
outcomes _before_ the result was known, and the losing one — "if you read this promptly, that is
evidence against the lane" — was a genuine chance to falsify it. That is worth more than any row
count in this document, and it is the shape future evidence here should take.

**What survives, and it is the part worth keeping:** the mechanism gap is verified _in code, not
inferred from aggregates_. `pendingInterrupts` admits only `isUrgent || steer`, so a routed
acceptance cannot reach a live seat through the ADR 088 interrupt line regardless of how the close is
later labelled. ryder's n=4 is direct observation, not a ledger average. And the 92%-reached-nobody
wake figure came from joining leases to causing acts, which is not epoch-sensitive in the same way.
The residency split stands on those; nothing else here is load-bearing.

**My error, twice in one evening, and it is one error.** dolly caught me keying a measurement on an
incidental column (`derivation`) rather than on what caused the row. I then verified ryder's
bimodality by _reproducing the arithmetic_ and called that verification — never asking what wrote the
labels or whether they meant the same thing across the window. **Reproducing a number is not
verifying a claim about what the number means.** The check that was missing both times is the same
one: _what wrote this row, and over what period does this label mean one thing?_

That check turned out to be the narrow case of a wider one. Both errors above are instances of the
defect class named in "The shared-predicate trap" — a value whose second consumer needs something its
first consumer never considered — and the generalized form of the question is stated there.

**Eval.** Report the answer rate **split by acceptor state at submit time** — never blended, and
**only over the post-217 window** where the labels are commensurable. That split is now motivated by
the mechanism (the states are genuinely different delivery paths), not by the retracted bimodality.

The split is **three-way, not two**, per the amendment to decision 1: _interruptible_ (live and in a
tool loop), _wakeable_ (offline), _neither_ (live but idle — routed to the free rail, not promptly
reachable by it, and disqualified from the paid one). **Report the size of that middle bucket
first.** It is currently unmeasured, it is the population for which #651 shipped a delivery guarantee
it cannot keep, and every other number here is a pooled average until it is known. If it turns out to
be near-empty the amendment is a footnote; if it is large, it is the next increment.

> **Superseded in emphasis by the 08-05 result, below.** The middle bucket is no longer the first
> thing to measure, because the result showed the dominant population is not idle-within-session but
> **session-ended** — the two overnight confirms landed within four minutes of a morning
> `claim.occupied`, after ~15 hours. So the Eval's first report is **time-to-answer decomposed against session
> boundaries**: how much of the interval is delivery, how much is the acceptor, and how much is
> simply _no session existing_. The three-way split remains correct about instruments; it is
> mis-weighted about populations, and the third term dominates and is diurnal.
>
> Three further requirements the result forced, each earned by an error it caught:
>
> - **Take the review grade from the `lane.closed` row, never the ask.** The two disagree in flight
>   and the ask's value goes stale (`01KZ2EN6S1`'s guard exists precisely to re-derive it).
> - **Do not compute "times told" from `interrupt.raised`.** It is audited once per (recipient, act)
>   while the line returns on every call — a first-occurrence count wearing an event count's name.
> - **State the measurement horizon before measuring.** The same six asks read 33% at a 15-hour
>   snapshot and 80% at close. A rate quoted without its horizon is not a result.

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

**Preconditions — a run that violates either of these returns a null that means nothing.** Both were
observed on 2026-08-04 while attempting exactly this measurement informally, and neither was in the
design above. They are stated as preconditions rather than confounds because they do not bias the
result, they void it.

1. **The daemon must be steady, not inside an autorefresh window.** autorefresh syncs, rebuilds and
   bounces the daemon on merge, holding the restart while the tip is still moving. An acceptance
   routed seconds before a bounce cannot be scored: if the acceptor answers, the restart is an
   uncontrolled co-intervention; if they do not, delivery failure is indistinguishable from the
   restart eating the delivery. Concretely, one ask on 2026-08-04 was routed at 16:46:05 and the
   daemon restarted at 16:46:38 — 33 seconds. **This precondition is adversarial to the phenomenon:**
   a merge burst is simultaneously when acceptance traffic peaks and when the rail is least
   trustworthy, so the excluded window is not a rare edge, and excluding it must be recorded rather
   than quietly dropped.
2. **A "live" arm requires the acceptor to be live _and executing tool calls_**, per the amendment to
   decision 1 above. A seat that holds a fresh heartbeat while idle is routed as live and is not
   reachable by the instrument under test, so pooling it into the live arm measures the wrong
   population and will understate the interrupt line. On 2026-08-04 an acceptance routed at 16:23:00
   was answered at 16:36:50 — 13m50s — by an acceptor who held **no session at all** during the
   interval; the hook had no boundary to fire at, and the delivery mechanism was a human starting a
   session. Scored naively that is a failed live arm. It is not: it is an offline case with no wake,
   and it belongs in the offline arm.

**Instrumentation this implies, and it should be built before the experiment rather than
reconstructed after.** Record at submit time, per routed acceptance: the daemon build, whether an
autorefresh was in flight, and the acceptor's state resolved to the three-way above
(_interruptible_ / _wakeable_ / _neither_) rather than the two-way `hasLivePresence` answer. Without
the third field the arms cannot be separated at analysis time, and the ADR would be measuring a
pooled population again — the error this document has already made twice.

### The result, 2026-08-05 — the rule fired, and the rule was under-specified

ryder ran the tally against their own change ([#651]) and led with the falsifier rather than burying
it: six acceptance asks reached the live rail on 08-04, two had closed, four were still
`awaiting_acceptance` 15–16 hours later. **2 of 6 = 33%**, against this ADR's 36% baseline. On that
reading delivery did not move the answer rate and this ADR is wrong.

I re-measured before writing it up, and the picture is different in ways that cut both directions.
Taking the favourable ones first, and flagging plainly what that means: **I am this ADR's author and
what follows is a reading that rescues it, which is exactly the post-hoc fitting this document has
twice caught itself doing.** So the corrections are stated as facts with their queries, the
un-rescued number is kept, and no vindication is claimed.

**Correction 1 — the set is 5 live-rail asks, not 6.** Lane `01KZ7JVWX2`'s
`lane.ready_for_review` row carries `wake_queued: 1`. It is a wake datum and belongs in the offline
arm; pooling it into the live arm is the exact error precondition 2 exists to prevent.

**Correction 2 — the snapshot was taken three seconds before it changed.** ryder's tally is
timestamped 08:58:01. izzo's acceptance of `01KZ7NQX71` landed at **08:58:04**, and two more followed
by 09:00:31. The measurement caught the ledger at the bottom of a diurnal trough. This document
already warns _"these are snapshots of a live ledger, not fixtures"_ — and the warning did not
prevent the third instance of the same error.

**The outcomes at close**, all `lane.closed` rows, live-rail asks only:

| Lane         | Acceptor | Outcome               | Time in review |
| ------------ | -------- | --------------------- | -------------- |
| `01KZ7GK9J5` | stanley  | `counterpart_confirm` | 13.8 min       |
| `01KZ7GR0V5` | miley    | `counterpart_confirm` | 22.4 min       |
| `01KZ7NQX71` | izzo     | `counterpart_confirm` | **904.8 min**  |
| `01KZ7NKKE5` | izzo     | `counterpart_confirm` | **891.6 min**  |
| `01KZ7HTSHG` | izzo     | still open            | 16.5 h and up  |

**4 of 5 confirmed = 80%**, against 17 of 33 = 52% over the whole post-217 window. The one wake-rail
ask in the set closed `review_unanswered` at 930.9 min.

**So which number is the result?** Both, and the disagreement is my fault. The pre-registered rule
says _"the answer rate does not move"_ and **never specifies a measurement horizon.** At a 15-hour
snapshot it is 33% and the ADR is falsified; at close it is 80% and the ADR is supported. A rule
whose verdict flips on a horizon it never named is not a decision rule. That is a defect in how I
wrote the falsifier, not in ryder's measurement, and it is the third instance in this document of the
same family: **a number that reads as a fact about the world and is actually a fact about when you
looked.**

**The finding that survives either horizon, and it is worse for the ADR than the rate is good.**
Two of the four confirms took roughly fifteen hours (904.8 and 891.6 min), and both landed within
**four minutes** of their acceptor occupying a session: izzo's `claim.occupied` is 08:54:36, the two
accepts 08:58:04 and 08:58:22. The overnight wake-rail ask closed `review_unanswered` in the same
burst at 09:00:31. Set beside the two-point decomposition below — told fast, answered in 94 s and in
2 min 11 s — the shape is unambiguous:

> **Delivery moved the answer rate. It did not move the answer latency, because the binding
> constraint is not delivery — it is session lifetime.** An acceptor answers when their session next
> exists. The interrupt line delivers into a live session reliably; when that session ends, delivery
> silently becomes "whenever they come back", and no delivery mechanism reaches across that gap.

This widens the "neither" bucket well beyond the idle-between-turns case the amendment described.
The dominant term is not idleness within a session, it is **the session ending** — and that is
diurnal, so it is large, predictable, and invisible to every instrument in the table above. Decision
1's three-way split is right about instruments and wrong about which population dominates.

**What this does not rescue.** The 80% is an answer rate over a horizon long enough that the
two-stage close's five-minute promise is meaningless within it. A confirm at 904 minutes against a
5-minute promise is not the mechanism working; it is the worker having self-closed or moved on long
before. So the practical conclusion is closer to ryder's than the rate suggests, and **nick's
tiering proposal is the right next shape**: if most acceptance latency is set by when the acceptor
next wakes up, then routing an ask for every change buys ritual, and the ones worth waiting for
should be the ones that declare they are.

**Why the four sat open rather than closing unanswered** — dolly, 08-05, and it is not a defect in
ADR 229. revive's policy row is `{"standing_reseat_known_agents":true,"loops":{"review":true,"dispatch":false}}`:
there is no `sweep` key, and `reaper.ts:83` skips every team where `loops.sweep !== true`, so
`sweepAbandonedAcceptance` has never run here. ADR 229 states that every team is bit-identical to
pre-229 until armed, and the code honours that. **The gap is that a safety backstop shipped opt-in
and nobody opted in** — the mechanism built to stop lanes waiting forever spent the night watching
four lanes wait. This changes the _labelling_ of the overnight state (open, not unanswered); it does
**not** change the answer rate, and must not be read as if it does.

### The delivery/acceptor decomposition — report these as two numbers, never their sum

Both clean wake-rail confirms, joined lease-to-close by `lane_id`:

| Acceptance                | Routed → leased | Woke → answered | Delivery share |
| ------------------------- | --------------- | --------------- | -------------- |
| gptbot, lane `01KZ7JAT55` | **11 min 55 s** | 1 min 34 s      | 86%            |
| ryder, lane `01KZ7MSAG4`  | **4 min 42 s**  | 2 min 11 s      | 68%            |

n=2, and no rate claim is made on two points. What they support is a claim about _mechanism_: the
acceptor is fast once told, and the telling is the slow part. This ADR is built on the sentence _"the
acceptor is never told"_; in both episodes the telling was slow and the acceptor was fast. **We have
been reporting delivery latency and acceptor latency as one number, and they are different
quantities with different fixes.** Report `time_to_lease` and `time_to_answer` separately. The
second episode is also within-seat: ryder produced both the live-rail n=5 and this wake-rail confirm,
which the design could not have arranged deliberately.

**A grading defect the decomposition surfaced.** ryder's acceptance was reported as `cross_model`;
the `lane.closed` row records `same_model`, while the `ready_for_review` row five minutes earlier
recorded `cross_model`. Both seats attest `claude-opus-5`, so `same_model` is correct — this is lane
`01KZ2EN6S1`'s re-derivation guard catching a stale grade in flight, and the first live instance of
it firing. Without it, wake-rail confirms would silently read as better-graded than they are. The
Eval must take the grade from the close row, not the ask.

**A delivery-count defect, ryder's, and it is the same skeleton again.** `interrupt.raised` is
audited **once per (recipient, act)** — `http.ts` gates the `appendAudit` on `hasInterruptRaised` —
while the interrupt line itself is returned on **every** call, outside that branch. So the four
unanswered acceptors were not told once; they were told at every tool boundary for as long as their
sessions lived, and the ledger shows one row each. **Repeated telling did not work either**, which is
a stronger result than the tally alone, and anyone computing "how many times was the acceptor told"
from that table undercounts by the acceptor's tool-call rate.
