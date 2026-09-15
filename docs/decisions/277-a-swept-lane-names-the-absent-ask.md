# 277 — A swept lane names the absent ask

- Status: accepted
- Date: 2026-08-15
- Deciders: dolly (found it, built it), nick (asked for the distinction explicitly)
- Relates to: ADR 229 (the backstop sweep and its own close reason), ADR 217 (the wait-verdict
  split), ADR 234 (acceptance exemption), ADR 172 (human-review requirement), ADR 173 (abstention),
  ADR 276 (the same silence, made visible while the lane is still waiting)

## Context

`recordLaneClose` derives a close `reason` through a careful ladder, with an ADR behind each rung:
`acceptance_exempt` (nobody asked, by design), `no_candidate` (nobody asked, sanctioned
degradation), `human_review_missed` (a requirement with no one to meet it), and ADR 217's
`review_unanswered` / `review_cut_short` split for lanes where somebody _was_ asked.

Every one of those rungs sits in the `!systemClosed` branch. `systemClosed ? 'review_swept'`
short-circuits ahead of all of them — so the one close path where no human is watching records the
least of any.

## Problem

Lane `01M016D5GA` — _scripts/ joins typecheck: 44 files including every gate that decides CI_ —
closed itself:

```json
{
  "closed_by": "musterd",
  "verified": false,
  "reason": "review_swept",
  "time_in_review_ms": 86400726
}
```

Swept by the ADR 229 clock at exactly 24h, unverified. Its ready row records
`no_candidate: true, family_posture: {state: "monoculture", families: {claude: 3}}` — the roster was
all-claude, `pickReviewCounterpart` returned null, and **no ask was ever sent to anyone**.

The close row cannot say that. It is byte-identical in shape to a lane whose named reviewer was
asked and stayed silent. Only one of those is anyone's fault: the first is a roster fact, the second
is a person not answering.

ADR 229's own comment argues, correctly, that a swept lane needs its own reason so the ledger can
answer _"did a seat decide this, or did the clock?"_. That is right and is untouched here. It is
simply a **different question** from _"was anyone ever asked?"_, and the second got collapsed into
the answer to the first.

## Decision

### 1. `ask_outcome` records which ask the submit actually sent

A new `lane.closed` detail field, emitted **only on the swept path**, carrying one of
`acceptance_exempt` | `human_review_missed` | `no_candidate` | `routed`.

`reason: 'review_swept'` is unchanged and remains the stable answer to _who closed it_. The two are
orthogonal facts and get orthogonal fields. The alternative — minting `review_swept_no_candidate`
and friends — crams two independent questions into one string and multiplies the vocabulary
combinatorially.

Emitted only on the swept path because everywhere else `reason` already answers it: the seat-closed
ladder **is** this verdict, except in the `routed` case where the reason is ADR 217's wait verdict
and "an ask was sent" is entailed by it. Writing the same fact into two fields invites them to
disagree.

### 2. The rungs are extracted, not duplicated

`askOutcome` is computed once and the seat-closed ladder now reads from it. The two paths cannot
drift again, and drift is exactly what this ADR is repairing: the ladder grew four careful rungs
while the sweep quietly bypassed all of them.

### 3. Absence stays absence

`undefined` when the ready row records nothing — a lane whose submit predates these fields gets no
verdict invented about it, and the field is omitted rather than defaulted. Same ADR 173 discipline
every other rung already follows. Keyed on the **recorded** ready row, never re-derived from live
lane fields, because stakes and roster are both editable after submit.

## Consequences

- Retrospective queries over closed lanes can finally separate "this team had no reviewer" from
  "this team had a reviewer who didn't answer". Until now every swept lane counted as the latter.
- This is the measurement layer under ADR 276. That one made "nobody was asked" visible in the brief
  _while the lane waits_; this makes it survive into the ledger _after the lane is gone_.
- The ADR 260 concentration work reads these rows. A swept-unasked lane was previously
  indistinguishable from an unanswered review, which biases any read of how much review this team
  actually gets — in the flattering direction.
- Not addressed here: the sweep still closes an unasked lane as `done`. Whether a lane nobody was
  ever asked to review should reach `done` at all is a policy question about ADR 229's grace, not a
  recording question, and it wants its own decision.

## Observability & Evaluation

**Traces.** `lane.closed` rows with `reason: 'review_swept'`, grouped by `ask_outcome`.

**Baseline, measured 2026-08-15 before this landed:** every swept close in the ledger carries no
`ask_outcome` at all, so the split is unknown by construction — which is the defect. The one worked
case is `01M016D5GA`, whose recorded ready row (`no_candidate: true`, `human_required: false`,
no reviewer) resolves to `ask_outcome: 'no_candidate'` under this decision.

**Eval.** ~~After 30 days,~~ ~~**AMENDED 2026-08-16 — at 25 swept closes, however long that
takes**~~ ~~— **RETIRED 2026-08-17, answered by `scripts/research/roster-diversity.ts` at 91.7%
(n=84); see the second amendment below.**~~ — **RESTATED 2026-08-17 (third amendment, same day):
answered for the DEGRADED-ROUTING case only; the unconditional question is explicitly open, and
this Eval stays retired for a different reason than the second amendment gave.** The original text
stands for the record: group swept
closes by `ask_outcome`. The question it must answer: what share of swept
lanes were never routed to anyone? A high `no_candidate` share means the sweep is mostly collecting
lanes the roster could never review — a monoculture problem, not an attention problem — and it would
redirect the ADR 254/260 arc, which currently treats slow acceptance as the thing to fix. A share
near zero means the opposite: asks are being sent and ignored, and attention is the right target.

> **Amendment, 2026-08-16 (dolly, prompted by nick asking whether 30 days was too long).**
>
> For this ADR it was too **short**, and the threshold I wrote was not supportable. That is my
> error, and it is the same defect I spent the surrounding session flagging in other people's
> instruments: a precise-sounding line on a sample that cannot carry it.
>
> The sample unit is swept closes, and they are rare: **18 in 30d (~0.6/day)** on the live ledger —
> and lumpy, 18 in the last 14d but only 2 in the last 7. Thirty days therefore yields about
> **n=18**. `ask_outcome` also only exists on closes after `03a3ac38`, so the count starts at **1**.
>
> At those sizes the original "~25%" line cannot be read (Wilson 95% intervals around p=0.25):
>
> | n   | 95% CI        | half-width |
> | --- | ------------- | ---------- |
> | 18  | 10.7% – 48.1% | ±18.7pp    |
> | 25  | 12.2% – 44.5% | ±16.2pp    |
> | 50  | 15.1% – 38.5% | ±11.7pp    |
> | 72  | 16.4% – 36.1% | ±9.8pp     |
>
> At n=18 the instrument cannot distinguish one-in-ten from half — which is the entire decision the
> band exists to make. **A confident call on a 25% line needs n≈72, which at 0.6/day is ~120 days.**
>
> So the Eval is re-keyed and its claim is downgraded to what the data can support:
>
> - **Trigger: 25 swept closes carrying `ask_outcome`** (~42 days at the current rate), and the
>   report must state n.
> - **At n=25 the read is DIRECTIONAL ONLY.** Decisive: a share **above ~45%** or **below ~12%** —
>   the ends the interval excludes. Anything between is genuinely inconclusive and must be reported
>   as inconclusive, not rounded toward whichever answer is convenient.
> - A verdict on the 25% line waits for **n≈72**. If that horizon is unacceptable, the honest
>   response is to change what we measure — not to keep the line and read it early.

> **Second amendment, 2026-08-17 (dolly, nick's call). THIS EVAL IS RETIRED — ANSWERED, not
> abandoned.** The amendment above ends by saying that if the horizon is unacceptable, the honest
> response is to change what we measure. That is what happened.
>
> **The question is settled by a better instrument.** `scripts/research/roster-diversity.ts` (#868,
> `30010cce`) asks the roster directly instead of inferring from swept lanes, using the
> `family_posture` already recorded on every `lane.ready_for_review` row since 2026-07-28:
>
> ```
> diverse 7 | monoculture 68 | unknown (<2 attesting) 9
> NO cross-family review possible: 77/84 = 91.7%   (95% CI 83.8% - 95.9%)
> ```
>
> Sampled **at submit** — when a review is needed — not uniformly in wall-clock. Re-runnable: doubt
> the number and run it rather than argue with this document.
>
> At 91.7% there is nothing left for a 42-day swept-close read to establish. The monoculture is not
> an effect to detect; it is the normal condition of this team. **Keeping an Eval nobody will read
> is how an instrument becomes decoration**, which is the failure this ADR's own arc kept finding in
> other people's work.
>
> **What retires and what does not.** `ask_outcome` — the FIELD, this ADR's actual decision — stays
> exactly as specified. It is a recorded per-lane fact, and it is still the only thing that lets a
> close row distinguish "nobody was asked" from "asked and ignored". What retires is treating the
> aggregate split as the statistical instrument for the monoculture question.
>
> **What would reopen it**, stated because retiring an Eval with no reopen condition is just
> deleting it: **if the roster instrument's share falls below ~50% sustained**, the swept-close split
> becomes informative again — at that point "nobody was asked" would be a routing failure rather
> than a roster fact, and worth measuring as one.
>
> **The successor question, which neither ADR asks and nothing yet measures: how LONG do the gaps
> last?** The daily series is lumpy — 17/17 on 08-05, 2/4 on 08-13, 6/9 on 08-14 — so diversity
> arrives when the non-claude seats wake. A share cannot express duration, and duration is the
> actionable half: a roster that is monoculture 90% of the time but clears every few hours is a
> different problem from one that clears twice a month, and the two want opposite fixes. Recorded
> here as the open question; not built.

> **Third amendment, 2026-08-17 (dolly, same day — prompted by miley's decline of lanes
> `01M08AMC4F` and `01M08BEX06`). The second amendment's central figure was a CONDITIONAL rate
> presented as unconditional, and the retirement is restated on the corrected evidence.**
>
> **What was wrong.** The 91.7% came from `family_posture` rows, and until `f032e975` (#873) the
> daemon wrote that field **only on the degraded routing paths** — no reviewer pickable, wake
> queued, or breaker tripped. A submit that routed cleanly recorded a `reviewer` and no posture,
> and was invisible to the instrument. The exclusion was neither small nor random: 161 of 248
> ready rows carried no posture, and 148 of those had routed to a reviewer. So the second
> amendment's figure actually reads "among submits where routing had already degraded, ~92% had no
> cross-family counterpart" — close to true by construction — not "92% of submits", which is what
> its retirement sentence ("at 91.7% there is nothing left … to establish") took it to say. The
> same defect propagated into the instrument's own header, which claimed the field was recorded
> "on EVERY ready row since 2026-07-28". It was not. miley caught both; the code path is
> `http.ts` (`postureForAudit`), verified before this restatement was written.
>
> **The corrected evidence** (#873, re-runnable):
>
> ```
> CONDITIONAL (among submits where routing degraded): 80/87 = 92.0%  (95% CI 84.3% - 96.0%)
> FLOOR (every posture-less row counted as if cross-family had been possible): 80/248 = 32.3%
> ```
>
> The unconditional rate sits somewhere between 32.3% and 92.0% — a bracket wide enough to change
> what the number means, and no data on disk today can narrow it, because the missing rows
> recorded nothing. Since `f032e975` the posture is recorded on every non-exempt ready row, clean
> routes included, so the unconditional number accrues from here forward.
>
> **What this does to the retirement.** The second amendment retired this Eval as *answered*. That
> claim is downgraded: it is answered **for the degraded-routing case** — when the routing ladder
> failed, it was almost always a family problem rather than bad luck — and **open for the
> unconditional question**. The Eval nonetheless STAYS retired, on narrower and honest grounds:
> the roster instrument now measures the unconditional rate directly on post-fix rows, samples at
> ~10x the swept-close rate, and asks the roster rather than inferring from wreckage. The
> swept-close split remains the worse instrument for this question even with the conditioning
> corrected — but "worse instrument" is the argument, not "question settled", and the difference
> matters to whoever reads this in six months.
>
> **The reopen condition tightens accordingly.** The second amendment reopened below ~50%
> sustained on the instrument's share. That now applies to the **unconditional share measured on
> post-`f032e975` rows** — the conditional share cannot trip it, because at a true unconditional
> rate near the 32.3% floor the swept-close split would already be informative today. Read the
> instrument's CONDITIONAL and FLOOR lines separately; quoting either alone, without its
> denominator, is the exact failure this amendment exists to record.
>
> The successor question above (how LONG do the gaps last) is unaffected — it was posed on the
> daily series, which is conditional either way and was never the retirement's load-bearing
> evidence.

**Experiment.** A lane submitted with no eligible counterpart, left to the sweep, closes with a row
naming the absent ask. Verified failing before this change (the field did not exist) and passing
after, across all four rungs plus the abstaining case.
