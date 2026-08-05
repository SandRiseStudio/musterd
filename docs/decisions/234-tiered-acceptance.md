# 234 — Tiered acceptance: declare the stakes before changing who gets asked

- Status: proposed
- Date: 2026-08-05
- Deciders: nick (proposed the tiering), stanley, ryder (carried the proposal, and insisted on the
  counterpoint that surface complexity predicts review cost rather than review value), dolly (the
  bucket split this ADR must be able to falsify itself against)
- Amends: [ADR 192](192-outcome-acceptance.md) — but **not in increment 1**, which changes no
  routing and no obligation
- Follows: [ADR 225](225-acceptance-must-reach-someone.md). This is its pre-registered fallback,
  arriving with a mechanism instead of as a concession

## Context

ADR 225 set out to make acceptance _reach_ its acceptor, and its own pre-registered falsifier says
that if delivery is fixed and the answer rate does not move, the honest response is to make the
two-stage close advisory in name as well as in fact. Two days of measurement have pushed toward that
response without quite arriving at it:

- **135 of 161 closes are unverified (84%).** The requirement is already advisory _in fact_ — seats
  self-close with a stated verification when nobody answers, and successive ADRs have blessed that
  as legitimate.
- **Delivery moved the rate and not the latency** (ADR 225's 08-05 result). Acceptors answer within
  ~2 minutes of being present and told; what varies by an order of magnitude is how long "present
  and told" takes, and overnight that is bounded by human sleep rather than by any rail we own.
- **dolly's bucket split, 08-05**, after two retractions of her own, is the sharpest evidence and it
  cuts partly _against_ tiering. Unverified closes divide roughly in half: **n=16 where the reviewer
  was never online and the mean wait was 8.4 minutes** — the _owner_ self-closed, so the binding
  clock is `promised_wait_ms`, not any grace — and **n=16 where the reviewer was online, with more
  awake time than the reviewers who successfully answered (0.67h vs 0.22h), and simply never
  answered.** Having time was not the problem; being re-surfaced was.

So universal-mandatory acceptance currently buys ritual: every submit routes an ask, now fires an
interrupt into a working seat, sometimes leases a paid wake — and five times in six ends unverified.
But dolly's split also means **neither failure is "too many asks were routed."** Tiering is not
obviously the fix for either bucket, and that is precisely why this ADR ships a measurement before
it ships a mechanism.

## Problem

Turning acceptance from noise into signal requires knowing which changes are worth eyes. Nothing in
the system records that today, so the question cannot be asked — let alone answered.

The tempting shortcut is to infer it from the diff: exempt docs, small UI, config. **ryder insisted
this counterpoint travel with the proposal, and it is decisive.** The two most valuable acceptance
reviews of 2026-08-04 were both on docs — miley's review of a landscape write-up caught a 209/210
miscitation, and ryder's review of ADR 225 changed its Decision on three points and killed a wrong
headline number. **Surface complexity predicts review _cost_, not review _value_.** An ADR is a
decision, not a doc, however it is stored. A filetype rule is the wrong knife.

## Decision

**1. Lanes declare their acceptance stakes, and the declaration is recorded.** A new `stakes` field
on the lane: `low` | `normal` | `high`. Declared by the worker, never inferred from the surface.
Recorded in the `lane.ready_for_review` audit row so the answer rate can be split by declared tier.

**2. The default is the routed tier.** `stakes` defaults to `normal`, and every lane written before
this ADR reads as `normal` — absence _is_ the declaration, so there is no backfill and no missing
data. An opt-in-to-acceptance design would fail silent: a worker who declares nothing would drop
below the line by inaction. **Forgetting must cost an ask, never a review.**

**3. It is not `risk`, and that is the point.** `risk` already has a consumer: ADR 169/172/188 route
the ask human-first on any tag. Hanging a second consumer with opposite needs off one value is
exactly the shared-predicate trap named in ADR 225 — "low stakes" cannot be expressed in `risk`
without either colliding with its empty default or accidentally demanding a human. The trap's own
prescription is to let each consumer state its own need, so this is a distinct field.

**4. Increment 1 records the label and changes nothing else.** No routing reads `stakes`. Every lane
routes exactly as it did yesterday. The routing flip — trivial tier routes no ask unless requested,
risky surfaces keep acceptance required — is **increment 2, gated on what increment 1 measures.**

### Why label-before-route, and not both at once

This is the sequencing question ryder put to me, framed as "run the three-arm delivery experiment
first, or stratify from day one." Both options are worse than splitting the shipment:

- **It gives a pre/post on identical population labels.** Under label-then-route, pre-flip asks are
  already tagged with the tier they _would_ have had, so a post-flip change in answer rate can be
  compared _within_ tier. Composition shift stops being a confound. Stratify-from-day-one does not
  buy this, because there the label arrives _with_ the flip.
- **It protects the sample, which is the confound nobody named.** Tiering does not merely shift the
  denominator, it **shrinks** it. At the observed volume the ledger is already thin; if the trivial
  tier stops routing, the event supply drops by whatever fraction that tier turns out to be — and
  nobody knows that fraction today, because nothing declares it. The label phase measures it before
  we spend it.
- **It makes this ADR falsifiable, cheaply.** The proposal rests on 84% unverified meaning the
  requirement buys ritual. The label tells us whether that 84% is _concentrated in the low tier_
  (the proposal is right, and exempting them costs nothing) or _spread evenly_ (the proposal is
  wrong, and the problem is delivery and re-surfacing, not stakes).

## Consequences

- One more thing to declare at `lane_open`. Mitigated by the default: declaring nothing is a valid,
  meaningful answer, and the common case needs no thought.
- A `--stakes` typo is refused rather than defaulted. Silently recording `normal` for a misspelled
  `low` would corrupt the measurement **in the direction that hides the effect being tested**, which
  is the worst available failure for a phase whose only product is data.
- `stakes` is editable after open. What a change is worth someone's eyes is often clear only once
  the work exists, and a declaration nobody can revise is one people learn to set defensively.
- Increment 1 buys no improvement to acceptance whatsoever. That is intended, and it is the cost of
  not building increment 2 on an assumption.

## Observability & Evaluation

**Traces.** `stakes` on every `lane.ready_for_review` audit row, recorded **unconditionally —
including when it is `normal`.** A field that vanishes on its most common value makes the largest
bucket the one the Eval cannot count, which is the same first-occurrence-versus-event-count skeleton
ADR 225 has now hit three times.

**Eval.** Dataset: `lane.ready_for_review` joined to `lane.closed` by lane id, over the post-234
window only (labels before it are all `normal` by definition and carry no signal). Baseline: the
current blended routed-acceptance answer rate, 17 of 33 = 52% over the post-ADR-217 window.

Report, split by declared tier:

1. **Tier composition** — what fraction of submits declare `low` / `normal` / `high`. This is the
   number that says how much sample increment 2 would cost, and it is unknown today.
2. **Answer rate within tier**, and **time-to-answer within tier** measured from the acceptor's
   first presence after the ask rather than wall-clock (ADR 225's 08-05 result: `time_in_review_ms`
   is wall-clock in state, and for anything spanning a night it mostly measures when the team
   stopped working).
3. **Whether declared stakes predict the answer rate at all.**

**The decision rule, pre-registered here so increment 2 cannot be argued into existence later.** If
the answer rate does not differ materially by declared tier — that is, if `low` lanes are answered at
about the rate `high` lanes are — then **stakes are not the discriminator and increment 2 must not
ship.** The unverified closes would then be explained by dolly's two buckets, and the work belongs
there instead.

Half of that alternative has already shipped: [ADR 233](233-owed-reviews-in-the-brief.md) gives the
orientation brief an `owed_reviews` field, so bucket B — a reviewer who was online and simply never
re-surfaced — now has a mechanism aimed at it. **This is a confound for increment 1 and must be
stated in the Eval output, not discovered afterwards:** 233 landed hours before this label, so the
post-234 window is also the post-233 window, and any improvement in the answer rate over the label
period is at least as plausibly 233's as it is anything tiering would later do. The label phase can
still answer its own question — whether stakes _differentiate_ — because that comparison is
within-window and across tiers, and 233 applies to all tiers alike. It cannot be used to claim a
level shift.

What remains unaddressed is bucket A: an owner giving up at the 5-minute promise, which points at
shortening or honestly restating `promised_wait_ms` rather than at tiering.

State the measurement horizon before measuring. ADR 225's falsifier flipped its own verdict between
a 15-hour snapshot and close because the rule never named one; this Eval reports **at close**, with
the still-open count stated beside it.

**Experiment.** Increment 1 is not an experiment — it is the instrumentation that makes one
interpretable. The three-arm delivery experiment in ADR 225 should stratify by tier from the moment
this lands, which is the second reason to ship the label first.
