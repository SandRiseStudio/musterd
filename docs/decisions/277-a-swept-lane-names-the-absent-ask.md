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

**Eval.** After 30 days, group swept closes by `ask_outcome`. The question it must answer:
what share of swept lanes were never routed to anyone? **A sustained `no_candidate` share above
~25% means the sweep is mostly collecting lanes the roster could never review**, which is a
monoculture problem and not an attention problem — and it would redirect the ADR 254/260 arc, which
currently treats slow acceptance as the thing to fix. A share near zero means the opposite: asks are
being sent and ignored, and attention is the right target after all.

**Experiment.** A lane submitted with no eligible counterpart, left to the sweep, closes with a row
naming the absent ask. Verified failing before this change (the field did not exist) and passing
after, across all four rungs plus the abstaining case.
