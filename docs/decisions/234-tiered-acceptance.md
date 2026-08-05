# 234 — Tiered acceptance: declare the stakes before changing who gets asked

- Status: accepted
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

> **Amendment (2026-08-05, hours after increment 1 merged): the 84% is partly an artefact, and this
> ADR's motivating statistic is weaker than it was when the proposal was made.** dolly's
> [ADR 235](235-self-close-sanction-needs-a-backstop.md) measured the unverified self-closes
> where the named acceptor was never active during the window (n=20). The owner closed at a mean of
> **8.5 minutes** — because `lane_submit` told them to, verbatim: _"wait ≤5m … on silence,
> `lane_resolve` yourself (recorded unconfirmed)."_ And the acceptor came back afterwards in **20 of
> 20 cases** — 55% within an hour, 100% within the sweep's 24h grace, a mean **106.8 minutes after
> the lane had already been shut**. Not one was a real silence.
>
> Those closes were not judgements that a change was not worth review. They were compliance with a
> hint. So an unknown fraction of the 84% below is the daemon's own instruction rather than evidence
> that acceptance buys ritual — and that fraction was never a stakes signal at all.
>
> **This is the falsifier this ADR pre-registered, arriving early and from someone else's lane.**
> The Eval below says that if unverified closes are not concentrated in the low tier then stakes are
> not the discriminator and increment 2 must not ship. dolly supplied a competing explanation _with
> numbers_ before the label had run a single day. The honest consequence is not that increment 1 was
> wasted — the label is exactly the instrument for telling the remaining stakes signal from this —
> but that **increment 2's bar has gone up**, because part of what motivated it has already been
> fixed by ADR 235. Read every number in this Context as pre-235.

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

**5. Increment 2 (2026-08-05): a declared-`low` lane routes no acceptance ask — except 1 in 5, drawn
at random per submit, which routes normally.** An exempt submit closes through its own terminal
reason, `acceptance_exempt`, never the null-pick path. A `risk` tag outranks the declaration: ADR 172
makes human review a requirement on a risky lane, and a worker's own "this is small" must not
dissolve a requirement they also declared — otherwise `stakes: low` becomes a second, quieter way to
clear `risk`, rebuilding §3's shared-predicate collision at the consumer instead of at the schema.

### Increment 2 shipped before its own gate, knowingly

The Eval below pre-registers that increment 2 must not ship until the label shows stakes predict the
answer rate. **It has shipped anyway, by nick's decision, with the trade in view.** That is an
override, not an argument that the rule did not apply, and the rule is left standing above rather
than quietly deleted — because it worked. It forced this conversation instead of letting a weaker
version of the same change land silently.

What it stopped is worth recording. The request that started this was a **surface-path** exemption:
"simple frontend changes don't need acceptance", with the path axis chosen explicitly over
no-observable-change and author-declared. miley declined to build it and escalated. The objection
that changed the decision was not this ADR — it was nick's own policy contradicting itself:

- his standing rule is that **all** web UI must be magical, warm and on-brand;
- ADR 172 routes user-facing work to a **human**;
- so a `packages/web` path rule would exempt precisely the category his risk policy most wants eyes
  on. It would have exempted the office overhaul and the enamel nameplates, and would **not** have
  exempted #676 — a pure perf refactor with zero user-visible delta, the one change in that week
  that genuinely needed nobody.

miley's framing is why the declared axis won: the frontend request was a no-observable-change request
wearing a path costume. Which is the same knife this ADR's Problem section already rejected — surface
complexity predicts review _cost_, not review _value_.

### The sampling hole, and why it is not optional

Exempting the low tier outright would destroy the ability to learn whether low lanes _would_ have
been answered. That is the sample-starvation confound this ADR named in "Why label-before-route" —
arriving by choice rather than by accident, which is worse, because a confound you chose is one you
cannot later claim to have discovered.

- The draw is **per submit and not derived from the lane id.** Hashing the id would make each lane
  permanently exempt or permanently sampled — a fixed subpopulation, not a sample — and a lane sent
  back and resubmitted would keep drawing the same answer.
- The draw is **recorded** (`exempt_sampled: true` on the ready row). A sampled-in low lane routes
  identically to one declared `normal`, so without the flag the sample produces data nobody can
  attribute to the tier that paid for it.
- The rate is a **named constant** (`ACCEPTANCE_EXEMPT_SAMPLE_RATE`), so it can be widened if the low
  tier starves.

### The terminal reason is a gate, not a nicety

An exempt lane must **not** close through `no_candidate`. That reason means "we wanted a counterpart
and could not get one" — the sanctioned degradation — and it is a live input to dolly's bucket split
and to this ADR's own 84% headline. Every exempt lane borrowing it would inflate the degradation
count with lanes that degraded nothing: **increment 2 corrupting the measurement increment 1 exists
to protect**, which is the one outcome that would make the whole arc worthless. `acceptance_exempt`
is therefore distinguishable in the ledger from both `no_candidate` and `self_close`, and carries its
own counters in the review projection.

It is derived from the **recorded** `acceptance_exempt` on the ready row, never re-derived at close
from `lane.stakes`. Stakes are editable after open (Consequences, below), so reading the live field
at close would let an edit made minutes later rewrite what the submit actually did — in both
directions. Only a recorded fact earns a label; this is the case where the tempting shortcut is a
field still sitting in front of you.

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
- Increment 2 makes `stakes` load-bearing, and a self-declared field that removes a check is one
  people can learn to set for the quiet rather than for the truth. Two things bound that: the
  declaration is recorded on every submit, so the ledger can show a seat whose lanes are all `low`;
  and the 1-in-5 hole means declaring `low` never guarantees the quiet, only makes it likely.
- The exemption removes the **ask**, never the possibility. A seat that reviews a low lane unprompted
  still records a verified `counterpart_confirm` — otherwise the exemption would suppress good news
  along with the noise.

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

**Both halves of that alternative have now shipped, and both landed _before_ this label.** Bucket B
went to [ADR 233](233-owed-reviews-in-the-brief.md) (`owed_reviews` in the orientation brief);
bucket A went to [ADR 235](235-self-close-sanction-needs-a-backstop.md) (the self-close
sanction made conditional on an armed backstop). So the alternative explanation is not a hypothesis
the label might rule out later — it is deployed code, and the amendment in the Context says what
that costs this ADR's premise.

**Two covariates, stated here so they cannot be discovered afterwards.** The post-234 window is also
post-233 and post-235. Record both merge SHAs beside the label data. The consequence is blunt:

- **The label may not be quoted for a level shift** in the answer rate. Any improvement over the
  label period is at least as plausibly 233's or 235's. That reading was already unavailable when
  233 landed; 235 buries it.
- **The label can still answer its own question** — whether stakes _differentiate_ — because that
  comparison is within-window and across tiers, and both changes apply to all tiers alike.

That is the question increment 2 turns on, so the phase survives. It just answers one question
instead of two, and the one it lost was never the one that mattered.

> **A third finding, and it invalidates an assumption this Eval rests on.** ryder (lane
> `01KZ9DZD9N`) established that the host slept in 19 cycles overnight, and that `reaper.ts:45-48`
> charges every expired lease against the attempt budget — so izzo's acceptance act was
> **terminally retired at 23:00:18** after three expired leases, nine hours before any seat could
> have answered. The lane then closed `review_unanswered`, which reads as a reviewer declining.
>
> This Eval's item 2 measures time-to-answer from the acceptor's first presence after the ask. That
> presumes the ask survives until they are present. Overnight it may not: the act can be retired
> while the host is asleep, and no tier a worker declares changes that. **Any acceptance whose ask
> was retired by lease exhaustion must be excluded from the tier comparison, not scored as an
> unanswered high-tier or low-tier ask** — otherwise the label measures the reaper.
>
> The deeper correction belongs to [ADR 225](225-acceptance-must-reach-someone.md), not here: its
> instrument table treats _wakeable_ as a property of the **seat**, and ryder has shown it is a
> property of the **host**. When the lid is shut every seat is in the "neither" bucket regardless of
> enrolment. That amendment is owed to 225 separately.

State the measurement horizon before measuring. ADR 225's falsifier flipped its own verdict between
a 15-hour snapshot and close because the rule never named one; this Eval reports **at close**, with
the still-open count stated beside it.

**The measurement window, named — owed since the proposal and fixed here.** Report at **n=20 routed
acceptances per tier, or 14 days from the increment 2 merge, whichever comes first.** Unbounded
"later" is exactly what made the path rule tempting: a gate with no deadline is a gate nobody has to
walk through. With the exemption live, the `low` denominator is fed only by the 1-in-5 hole, so that
tier will reach n=20 roughly five times slower than the others — which is a cost of increment 2 and
is stated here rather than discovered as a surprise at the report.

**Traces added by increment 2.** `acceptance_exempt: true` on the ready row of an exempt submit (in
place of the routing branch, never alongside `no_candidate`); `exempt_sampled: true` on the 1-in-5
that routed anyway; `reason: 'acceptance_exempt'` on the close. All three surface in
`deriveReviewMetrics` as their own counters, because a bucket that exists only in the raw audit log
is one the team cannot read without an admin credential — the defect that projection was built for.

**The rollback condition, pre-registered.** If the label shows declared stakes do **not** predict the
answer rate, **the exemption is withdrawn — not grandfathered.** Shipping increment 2 ahead of its
gate is a bet placed on the founder's authority, and a bet has to be settleable. "It is already
built" is not evidence and must not be allowed to become the reason it stays.

> **A threat to that rollback test, raised by miley on 2026-08-05, before the exemption shipped.**
> All ten pending acceptance asks on the team were routed to nick — 3 dolly, 3 izzo, 2 miley,
> 2 stanley — because every agent seat on the roster attests `claude-opus-5`, so ADR 188's ladder can
> never find a cross-family peer, and `gptbot` attests no model at all and is ineligible under ADR
> 158/187. There is currently **no eligible agent acceptor on this team**, and the sole human acceptor
> was offline.
>
> If the entire acceptance denominator is asks routed to one offline person, then "the answer rate by
> declared tier" is substantially measuring **his availability**, not the stakes. The rollback test
> would then be unable to fire for a reason that has nothing to do with tiering — and a rollback
> condition that cannot fire is decoration. This is a third covariate beside 233 and 235, and unlike
> those two it is not fixed by anything shipped: the remedy is enrolling one genuinely cross-family
> seat, which is a wake-pool problem (grokbot's lane `01KYZAT6CP` named it first) and belongs to
> whoever owns residency.
>
> **Consequence for the report:** state the acceptor composition beside every tier number. If the
> monoculture still holds at the window, the tier comparison is reported as **inconclusive** rather
> than as a pass — and an inconclusive result withdraws the exemption, because the burden sits with
> the increment that shipped early.

**Experiment.** Increment 1 is not an experiment — it is the instrumentation that makes one
interpretable. The three-arm delivery experiment in ADR 225 should stratify by tier from the moment
this lands, which is the second reason to ship the label first.
