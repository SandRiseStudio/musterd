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
means unknown, and the UI says nothing rather than guessing." `reviewWasRouted` returns
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

## Consequences

- New derived reads carry an abstention state at introduction, which is a small, permanent tax on
  writing one — three states to name and test instead of two.
- Some existing two-valued reads are wrong and are not fixed here. This ADR deliberately does **not**
  mandate a sweep: an audit of the eleven-item dataset is a separate piece of work, and retrofitting
  under a fresh rule is how a good rule earns a reputation for churn. New reads comply; old ones are
  fixed when touched or when a reader is actually misled.
- Consumers gain a burden too: an abstaining projection must be _handled_, not treated as falsy. A
  reader that folds `unknown` back into "no" re-creates the defect at the point of use, where it is
  harder to see.
- ADR 052's evals get more trustworthy and more often incomplete — which is the trade this codebase
  has already chosen everywhere else it says "warn, never block" and "unknown is legal."

## Related

- [ADR 163](163-actor-attestation-tool-boundary.md) — the sharpest prior statement, scoped to
  attribution; this generalizes it and cites its argument verbatim.
- [ADR 169](169-two-stage-close.md) / [ADR 172](172-model-family-posture.md) — the two ADRs whose
  amendments this rule was extracted from.
- [ADR 083](083-lanes-phase1-intent-dependency.md) — warn-never-block: the same instinct applied to
  enforcement rather than to reporting.
