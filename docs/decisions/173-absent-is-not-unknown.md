# 173 — Absent is not unknown: a projection abstains rather than guesses

- Status: accepted — 2026-07-28. Authored by ryder (nick-directed, after the pattern surfaced three
  times independently in one day). Number **173** — verified free on `origin/main` (highest is 172)
  at branch time.
- Date: 2026-07-28
- Builds on: [ADR 163](163-actor-attestation-tool-boundary.md) (the closest prior statement of this
  rule, scoped to model attribution — this ADR generalizes it),
  [ADR 158](158-model-attestation-truth.md) / [ADR 101](101-model-as-a-variable.md) (`MODEL_UNKNOWN`
  and the `unverifiable` chain verdict — the first place the rule was implemented),
  [ADR 169](169-two-stage-close.md) (the `no_candidate` split that made the rule visible),
  [ADR 172](172-model-family-posture.md) (the three-state posture),
  [ADR 052](052-traces-evals-first-class-gate.md) (evals read off these projections, so a guessing
  projection corrupts an eval).

## Context

On 2026-07-28 the same defect was found and fixed three times, by two seats, on three unrelated
surfaces, none of whom set out to find it:

| surface                              | the two-valued read         | what it asserted, falsely                                                                |
| ------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------- |
| lane close reason (#450, izzo)       | reviewed / not reviewed     | "asked and ignored" (`review_timeout`) for a lane where **nothing was ever asked**       |
| doctor guidance check (#448, ryder)  | recorded-and-present / gone | a file that was never expected **could never be reported missing**                       |
| `musterd report review` (#461, izzo) | routed / no-candidate       | pre-instrumentation rows would have been **guessed into a split that did not exist yet** |

Two more landed the same day as deliberate applications of the rule once it had been seen:
ADR 172's three-state posture (`unknown` when fewer than two agents attest), and #462's
`human_review_missed` split (a _required_ human who was never live is not the same fact as an empty
cross-family pool).

And the rule is already written down — locally, eight times, by at least four authors. `MODEL_UNKNOWN`
"poisons conclusions _honestly_ — a chain with an unknown link is diversity unverifiable, never
diverse." The mast verdict is `flagged | unverifiable`. Lane `verified` is optional because "absent
means unknown, and the UI says nothing rather than guessing." `reviewRouting`'s `routed` is
`boolean | undefined`. ADR 021: the adapter "never invents a driver it wasn't told about." ADR 044:
"the server never invents it." ADR 067: "refuses rather than guessing." ADR 163 states it most
sharply, scoped to attribution:

> A silently-wrong model attribution corrupts the diversity conclusions exactly as badly as a missing
> one — worse, because it looks trustworthy.

So this is not a new idea. It is an idea this codebase has independently rediscovered at least eight
times, and it keeps being rediscovered because it has never been named at a level where the next
author can apply it before shipping the two-valued version.

## Problem

A projection reports a fact it derives from evidence. When the evidence is missing, a two-valued
read has nowhere to put that, so it silently returns the value that means "the thing is not so" —
collapsing **absent** ("I looked; it is not there") into **unknown** ("I cannot see whether it is
there").

The collapse is invisible, because the wrong answer is well-formed. `review_timeout` is a legal
close reason. `monoculture` is a legal posture. A doctor reporting no drift is a legal health check.
Nothing errors, nothing looks broken, and a reader — human or agent — draws a confident conclusion
from a value that was manufactured by the absence of evidence.

The cost is worst exactly where musterd is trying to be rigorous. ADR 052's flywheel reads evals off
these projections; a projection that guesses does not merely lose information, it **fabricates the
datum the eval is about**. ADR 169's counter-metric would have indicted a tier choice and a picker
for what was actually an empty roster. ADR 172's posture would have reported a fleet as one family
on the strength of a single seat. In each case the metric fires at the wrong subsystem, and the
louder it fires the more wrong it is.

## Invariant

> A projection that cannot see the evidence for a fact **says so**. It never reports the absence of
> evidence as evidence of absence, and it never applies a distinction retroactively to data recorded
> before that distinction existed.

## Decision

**Three-valued by default for any derived read.** A projection over evidence has at least three
outcomes — the fact holds, the fact does not hold, and _the evidence does not support either_ — and
the third is a first-class value with its own name, not `null` overloaded, not a boolean's falsy
side, and not an omitted field the reader must interpret.

Applying it has four parts, each learned from one of the instances above:

1. **Name the abstention after its cause, not after its shape.** `unknown` is acceptable when there
   is one way to be uninformed; when there are several, they are different facts and get different
   names. `no_candidate` (nobody was eligible) and `human_review_missed` (a required human was never
   live) are both "no ask was sent", and collapsing them would rebuild the defect one level up.
2. **Record the distinction where it is known, not where it is needed.** #450's fix was not a better
   guess at close time — it was writing the routing outcome down at _ready_ time, the only moment it
   was knowable. A projection cannot recover a fact the system declined to record; the fix for a
   guessing read is almost always an earlier write.
3. **Never backfill a verdict onto history.** Rows recorded before a distinction existed keep their
   old label and are reported as legacy, explicitly. #450 and #461 both did this. Backfilling would
   make the record _look_ complete while asserting things about the past that nobody observed —
   which is the original defect wearing the costume of a migration.
4. **Say what the abstention costs.** A projection that abstains without saying how much it abstained
   over invites the reader to treat its remainder as the whole. #461's line naming the legacy rows
   is the model; it took running against real data to see the need for it.

### When this does _not_ apply

Two-valued is correct when absence is **provably** meaningful: the reader controls the domain and can
enumerate it. A closed set you wrote yourself — a state machine's states, an enum, a config file you
just parsed — has no invisible third case, and inventing one there adds ceremony while teaching
nobody anything.

The test is one question: **is there a real state of the world in which I lack the information rather
than the fact being false?** For anything derived from an append-only log, a presence table, an
attestation, a filesystem, or another process's behaviour, the answer is yes — those are all evidence,
and evidence can be missing. For anything you fully enumerate in the same function, the answer is no.

Blanket three-valuing everything would be its own failure, and this ADR does not ask for it.

## Observability & Evaluation

**Traces.** No new instrument, and unusually the honest reason is that the rule's violations are
already recorded — in git. A violation looks exactly like _a PR that adds a third state to an
existing two-valued read_, which is to say a correction. #450, #448 and #461 are three such
corrections in one day. That is the trace, and it is countable without building anything.

**Eval — dataset and baseline.** The dataset is the eleven derived reads this codebase currently has
that touch evidence (the five surfaces above plus `MODEL_UNKNOWN`, the mast `unverifiable` verdict,
lane `verified`, `reviewWasRouted`, ADR 168's `stale`/`ahead` split, and ADR 141's `offline_reason`).
The baseline is the damning half: **four of the five identified this week shipped two-valued first
and were corrected afterwards**, each after the wrong value had already been served to a reader.

The fifth is the interesting one, and it is the argument for this ADR existing at all. ADR 172's
posture shipped three-valued **at introduction** — and its author had read izzo's `no_candidate`
correction the previous day. One data point, but it points the right way: the rule is cheap to apply
prospectively and expensive to discover retrospectively, and the difference between the two was
having seen it named recently.

**Experiment.** Pre-registered and able to fail. The trigger is the next derived read added to
`GET /report`, to an audit-derived reason, or to a health check. Does it ship with its abstention
state at introduction, or does it need a follow-up PR to add one?

- Ships correct ⇒ the naming did its work; leave it as prose.
- Needs a correction ⇒ one instance is noise, this ADR stays.
- **Kill criterion: two consecutive corrections after this lands** ⇒ prose is insufficient, and the
  answer is a mechanism rather than a better-written rule — a required question in the ADR template
  ("what does this projection say when it cannot see?"), or a lint over derived reads returning bare
  booleans. A doctrine ADR that does not change behaviour is decoration, and this one should be
  measured for that rather than assumed innocent of it.

_Standing count, kept here so it cannot drift — **two counters, deliberately apart** (verdict
2026-07-30, see "The ledger, settled"):_

- _**Kill-criterion experiment: 0 triggers, 0 corrections.** Un-run. No newly added derived read has
  appeared on the three named surfaces since this ADR landed._
- _**Old reads fixed when touched: 2** (`reviewRouting` #517, `insights.ts` #521). Diagnostic only.
  This counter fires nothing._

## Consequences

- New derived reads carry an abstention state at introduction, which is a small, permanent tax on
  writing one — three states to name and test instead of two.
- Some existing two-valued reads are wrong and are not fixed here. This ADR deliberately does **not**
  mandate a sweep: an audit of the eleven-item dataset is a separate piece of work, and retrofitting
  under a fresh rule is how a good rule earns a reputation for churn. New reads comply; old ones are
  fixed when touched or when a reader is actually misled. _That audit has since been done — see
  "The sweep question, answered" below. It found nothing to sweep, and the sentence above overstates
  its own premise._
- Consumers gain a burden too: an abstaining projection must be _handled_, not treated as falsy. A
  reader that folds `unknown` back into "no" re-creates the defect at the point of use, where it is
  harder to see.
- ADR 052's evals get more trustworthy and more often incomplete — which is the trade this codebase
  has already chosen everywhere else it says "warn, never block" and "unknown is legal."

## The sweep question, answered — 2026-07-29

The no-sweep call above was made by this ADR's author, who asked izzo to push back on it. She never
replied. So it stood for a day on nobody's judgement but its own, which is the only reason it was
still open. Answering it properly meant doing the audit the ADR had deferred.

**The audit. All eleven, read in code rather than argued about:**

| #   | dataset item                       | verdict                                                               |
| --- | ---------------------------------- | --------------------------------------------------------------------- |
| 1   | lane close reason (#450)           | corrected — three-valued                                              |
| 2   | doctor guidance check (#448)       | corrected                                                             |
| 3   | `musterd report review` (#461)     | corrected                                                             |
| 4   | ADR 172 posture                    | shipped three-valued at introduction                                  |
| 5   | `human_review_missed` split (#462) | corrected                                                             |
| 6   | `MODEL_UNKNOWN`                    | compliant — `packages/protocol/src/model.ts:15`                       |
| 7   | mast `unverifiable` verdict        | compliant — `packages/server/src/store/mast.ts:201`                   |
| 8   | lane `verified`                    | two-valued and **correctly** so — see below                           |
| 9   | `reviewWasRouted`                  | three-valued `boolean \| undefined` — and **dead code**, zero callers |
| 10  | ADR 168 `stale`/`ahead`            | compliant, and the exemplar of the rule                               |
| 11  | ADR 141 `offline_reason`           | compliant — explicit `'unknown'` enum member, pinned by test          |

**Zero of the eleven is an unfixed violation.** There was nothing to sweep. Two of the verdicts are
worth their own line, because both are cases where the rule's _carve-out_ is doing the work:

- **Lane `verified`** (`http.ts`) is computed from `lane.state`, `owner_at_close` and the closer's
  name — every input enumerated in the same function. That is the "closed set you wrote yourself"
  exemption, and three-valuing it would add ceremony and teach nobody anything. It is then _stored_
  optional so the UI abstains, which is where the third state actually belongs.
- **ADR 168's `stale`/`ahead`** is the best instance in the codebase: two early returns that abstain
  out loud — "absent or unparseable — say nothing rather than invent drift", and "never installed
  here — not this check's business". Its one collapse is sanctioned: `hookEpochOf` returns `0` for an
  unstamped command, which reads as stale, and an unstamped hook genuinely _is_ from a pre-stamp
  build. Absence of the stamp is evidence, not missing evidence — and the message prints `epoch 0`
  rather than hiding the inference.

**So the framing was the defect, not the code.** "The eleven-item dataset" is the eval's
_population_ — five of them the week's corrections, six of them places the ADR cites as the rule
already being right. It was never a backlog of eleven suspect reads. Reading it as a to-do list is
what made a sweep look owed, and the handoff note that carried this question forward made exactly
that misreading. **"Fixed when touched" stands, now on evidence rather than on the author's
preference.**

**Two findings the audit turned up, neither of them one of the eleven:**

1. `reviewWasRouted` has no callers — `reviewRouting` (#462) superseded it. Deleted here. It was
   compliant and unused, which is the least interesting way to be correct.
2. **A twelfth item the dataset does not contain, and it is a real instance.** In `reviewRouting`,
   `human_required` is a bare boolean on the _read_ edge while its sibling `routed` is three-valued
   in the same return object. It returns `false` both for a legacy row that predates #462 and for a
   `catch`-ed JSON parse failure — so "I could not see whether a human was required" is served as "no
   human was required". At the close edge `human_review_missed` gates on it, so ADR 172's
   counter-metric silently undercounts over those rows with no line saying how much it abstained
   over, which is clause 4 of this ADR violated by the very function that motivated it. Narrow in
   reach; exact in shape. Filed as its own lane rather than fixed inline, because a correction is
   this ADR's trace and it should be recorded as one, not folded into a docs change.

   Note what it is _not_: `human_required` is correct at the **write** edge, where it is
   `lane.risk.length > 0` — a set the writer owns. Only the read is wrong. That is clause 2 ("record
   the distinction where it is known") pointing at the fix.

**On the experiment, and the ADR 177 question.** ADR 177 (#476) shipped a three-valued declaration at
introduction, and the question put to this session was whether that counts as the registered trigger.
**It does not**, and the reasoning matters more than the answer. The trigger was pre-registered
narrowly: "the next derived read added to `GET /report`, to an audit-derived reason, or to a health
check". ADR 177's `frozenBy`/`unfrozen` plus `building` is an authoring invariant and a check summary
line — none of the three named surfaces. Counting it would mean widening a pre-registered trigger
after the fact in order to collect a _favourable_ data point, which is the same error class as tuning
a guard until it passes, and this codebase has one of those open already.

So the experiment stands at **zero triggers, N=0** — not at one-in-favour. The honest position is
that it has not been run, and the no-sweep call rests on the audit above rather than on any
experimental evidence. The kill criterion is unchanged and still live: two consecutive corrections
after this landed ⇒ replace the prose with a mechanism. Finding 2 above will be the first correction
if it lands as one, and by the ADR's own regime it is an "old one fixed when touched" rather than a
trigger hit — the distinction is what keeps the count honest.

## Correction #1 — `reviewRouting.human_required`, landed 2026-07-29

Finding 2 above landed as a fix. It was first logged here as "correction #1" against the kill
criterion; **that was wrong and is corrected below** — it is an old read fixed when touched, which
this ADR's own regime excludes from the trigger, and therefore from the criterion that counts
corrections to triggers.

`human_required` is three-valued now, on the read edge only, exactly as clause 2 pointed. What made
the fix bigger than a type change were two things the audit could not have seen from the outside, and
both are worth carrying forward as evidence about the _shape_ of this defect class:

1. **The abstention had to be created at the write edge before the read could report it.** The ready
   edge wrote `human_required` only when true, so absence meant "not required" _or_ "legacy row" —
   indistinguishable. A three-valued read alone would have abstained over every ordinary no-risk
   lane: strictly more honest and completely useless, an unknown so common it carries no information.
   The field is now always written, both ways, so absence means precisely "written before that
   change". **The lesson for clause 2: "record the distinction where it is known" is a claim about
   the writer, and a reader cannot become honest on its own if the writer threw the distinction
   away.** An omitted `false` is not a smaller record than an explicit one — it is a lossy one.

2. **The `catch` this ADR reasoned about was unreachable, and the actual failure was worse than a
   wrong answer.** The lookup filtered on `json_extract(detail, '$.lane')`, so an unparseable row
   made SQLite raise from the _query_, before the try — and because that expression was evaluated
   over every `lane.ready_for_review` row the scan touched, a single corrupt row broke the close edge
   for **every lane**, not just its own. _(Correction, measured by ryder 2026-07-29: the sweep this
   paragraph originally recommended does not pay, and the throw is not reachable in practice — both
   audit writers are `x ? JSON.stringify(x) : null`, and `json_extract` over `NULL` returns `NULL`;
   only `''`, plaintext or genuinely malformed JSON raises, which needs direct DB manipulation. Nor
   is it a performance argument: 0.451ms vs 0.430ms for the `target=` form on the real DB, and
   28.6ms vs 32.0ms at 32× scale — `json_extract` is not slower at all. The real cost is a missing
   index on `action`, which hits both forms equally, tracked as its own lane. The `target=` filter
   here stands on being the narrower, more obvious predicate, not on a hazard it removes fleet-wide.
   Recorded because the recommendation was mine and it was wrong.)_ The filter is now the `target` column (the ready
   edge already writes the lane id there), which leaves exactly one JSON parse, inside the try, where
   the ADR always assumed it was. Noted because the ADR's own framing — "a read that cannot parse its
   evidence returns a confident value" — quietly assumes the read _survives_ the unparseable
   evidence. Sometimes the projection does not abstain OR lie; it throws, and takes its neighbours
   with it — a third failure mode worth holding in mind even where, as here, the conditions for it
   turn out not to arise.

The counter-metric is also legible for the first time: `human_review_missed` closes had no bucket in
`deriveReviewMetrics`, so the reason ladder's `else` counted them as `self_close` — "never entered
review", said of a lane that entered review and whose required human never came. ADR 172's number was
not merely undercounted on abstaining rows; where it did fire it was filed under its opposite. Both
`closed.human_review_missed` and `closed.human_required_unknown` are now reported, the second being
clause 4 made operational: the count says how much the first one abstained over.

## The residual, one level below correction #1 — 2026-07-29

Giving `human_review_missed` its own bucket fixed the row that had been landing in the wrong place. It
did not fix the **`else` that had been catching it**, which still read:

```ts
else m.closed.self_close++; // includes legacy rows with no reason recorded
```

`self_close` is a _recorded_ reason asserting "never entered review". As the ladder's `else` it also
absorbed a close that recorded **no** reason (the legacy single-stage shape) and one carrying a reason
this build **cannot classify** (written by a newer musterd) — then made that positive claim on behalf
of rows that made none. Two ways of being uninformed, with different remedies: nothing to be done
about a legacy row, upgrade the reader for the other. So clause 1 gives them separate names,
`legacy_unlabelled` and `unknown_reason`, rather than one shared `unknown` that would rebuild the
collapse one level up. `self_close` now matches explicitly, and a test asserts the buckets **sum to
`total`** — an abstention that is merely uncounted misleads exactly as much as one miscounted.

The pattern worth extracting: **fixing a collapse by adding a case does not fix the arm that was
absorbing it.** Correction #1 moved one reason out of the `else` and left the `else` as wrong as it
found it, for two other reasons. A default arm that means "everything I did not name" is an abstention
whether or not its author thought of it that way, and it needs a name for the same reason the values
above it do.

### The ledger, settled — 2026-07-30 (izzo's call, ryder concurring)

The question ryder left open — is #521 correction #2, firing the criterion, or the same correction as
#517 incompletely applied? — was **neither**, and the ledger itself was the defect.

**Read the Experiment block as written.** Its three bullets are all outcomes _of the trigger_: "the
next derived read ADDED to `GET /report`, an audit-derived reason, or a health check — does it ship
with its abstention state at introduction, or does it need a follow-up PR?" So "needs a correction"
means _a triggered read needed a follow-up_, and the kill criterion — "two consecutive corrections" —
counts corrections **to trigger instances**, not archaeology. Both #517 and #521 are old reads
pre-dating the ADR, surfaced by audit. Under the ADR's own regime that is "fixed when touched", which
it explicitly says is not a trigger hit; it follows that neither is a criterion correction either.

So the ledger is **two counters**, and they must never be added together:

| counter                                                        | value          | fires anything?        |
| -------------------------------------------------------------- | -------------- | ---------------------- |
| Kill-criterion experiment (triggers / corrections-to-triggers) | 0 / 0          | yes — at 2 consecutive |
| Old reads fixed when touched                                   | 2 (#517, #521) | no, diagnostic only    |

**Why this reading and not the flattering one.** Under "2 = fires", the criterion would be spent on
two pre-existing bugs found by a single audit — and a genuinely new two-valued read shipping next
week would arrive with the criterion already burned, which is the outcome the criterion exists to
prevent. It also costs the reading that would have looked best for this arc ("two findings in one
day, the prose is working hard"): under the correct reading, neither finding is evidence about the
prose at all, because the prose was never in front of the people who wrote those reads.

**Recorded as a joint error, not ryder's.** He asked for a count without specifying which of two
senses it counted; I pinned it without noticing the ambiguity. It stood wrong for about an hour. The
author-marks-own-homework hazard ([ADR 171](171-provisioned-workspace-currency.md)) was real and he
was right to hand it off — and the handoff worked in the direction it was supposed to: the answer
that came back was the one that cost the answerer something.

### Prose-insufficiency evidence that stands outside the experiment

This belongs in the record whatever the counters say, because no counter would ever have caught it.

**Correction #2's defect was one line below correction #1's, in a function izzo was editing at the
time, while consciously applying this rule.** #517 added two abstention buckets to
`deriveReviewMetrics`'s reason ladder — the act of applying clause 1 — and left the `else` arm
directly beneath them collapsing two more abstentions. The rule was not merely available, not merely
recently read: it was _the thing being done_, in that function, in that minute. It still did not
catch a third abstention one line away.

That is a strictly stronger argument for a mechanism than any tally of corrections, and it points at
the shape of the mechanism too: the miss was a **default arm**, which reads as control flow rather
than as a value, so a rule phrased about _what a projection returns_ slides right past it. A lint
would want to treat `else` in a classifying ladder as one of the cases — because that is what it is.

**Forward note for whoever hits the trigger first.** Two candidate trigger instances are visibly
coming, and whoever builds either is the experiment: the `delivery_hint` rail has no `nudge.*` /
`delivery.*` audit vocabulary at all, so "no hint was warranted" is indistinguishable from "the code
never fires" (stanley, 2026-07-29) — and [ADR 179](179-board-triggered-work-order-wakes.md)'s
per-loop observability adds derived reads by design. If your new read ships three-valued at
introduction, say so in your PR: that is the datum, and it is the one the criterion has been waiting
for.

## Related

- [ADR 163](163-actor-attestation-tool-boundary.md) — the sharpest prior statement, scoped to
  attribution; this generalizes it and cites its argument verbatim.
- [ADR 169](169-two-stage-close.md) / [ADR 172](172-model-family-posture.md) — the two ADRs whose
  amendments this rule was extracted from.
- [ADR 083](083-lanes-phase1-intent-dependency.md) — warn-never-block: the same instinct applied to
  enforcement rather than to reporting.
