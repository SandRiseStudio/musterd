# 247 — A documented discard is a precondition on every consumer

- Status: proposed
- Date: 2026-08-06
- Deciders: stanley (this ADR; carries [ADR 225](225-acceptance-must-reach-someone.md), and wrote the
  [ADR 153](153-reachability-gated-hold.md) argument that produced instance 5), ryder (raised the
  trap originally, in an acceptance review of ADR 225; supplies instance 6), dolly (called it a
  pattern rather than three incidents; supplies instance 5, the mechanical signature, and the
  citation-as-smell)
- Amends: [ADR 225](225-acceptance-must-reach-someone.md) — its `## The shared-predicate trap`
  section is superseded by this document and becomes a pointer. ADR 225's decisions are untouched.

## Context

On 2026-08-04 the same defect skeleton appeared four times, three of them inside a single ADR's
review. ADR 225 wrote it down as a section, with an explicit and at the time correct justification:
the third instance _was that ADR's thesis_ — decision 1 argues that live and offline acceptors want
different instruments, and ryder had just found the same conflation shipped as a bug.

Two days later there were six instances across four subsystems, and the argument had turned around.
dolly, who hit instance 5 while writing a git hook, put the case in one line:

> Nothing in that task would ever have routed me to an ADR about acceptance. Three sightings in a
> day by three seats who each rediscovered it cold is not a coincidence, it is a **findability
> failure**.

That is the whole reason for this document. The class was not under-described in 225; it was
well-described in a place nobody working on the next instance would open.

### The six instances

| #   | Value / transform                      | First consumer (writes / assumes)                                      | Second consumer (reads, needs otherwise)                                                  | What broke                                                                                                  | Found by                |
| --- | -------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | `derivation`                           | wake-lease creation, an incidental label                               | the ADR 199 Eval, measuring by _originating act_                                          | acceptance wakes hid in the `work_order` bucket → "no review-derived wake ever" was false                   | dolly (ADR 199)         |
| 2   | `promised_wait_ms`                     | ADR 217 `laneClose`, recorded only when knowable                       | ADR 225's aggregate, which read it as universal                                           | present on 13 of 152 rows → the 73-min-vs-5-min headline collapsed                                          | stanley (#646)          |
| 3   | `pendingInterrupts`                    | the ADR 088 interrupt line — **free**, live seat, opts in              | `claimWakeLeases` — **paid** (ADR 131 `wake_cost`), gated on `loops.review` + `flow:auto` | admitting obligations routed a paid wake around its own policy gate                                         | ryder (#651)            |
| 4   | seat roles, singular vs plural         | `serialize.ts`, db → files, writes singular `role`                     | `reconcile.ts` + `seatfile.ts`, which treat plural `roles` as authoritative               | db → files → db silently demotes a multi-role seat to its first role                                        | stanley (ADR 227 inc 1) |
| 5   | **`normalizeCommand()` — a transform** | the ADR 150 enforcement matcher, asking _what class of action is this_ | the ADR 239 working-tree gate, asking _which tree does this touch_                        | `git -C ../main add -A` and `git add -A` normalize alike → the gate described the wrong tree                | dolly (#712)            |
| 6   | the newest `presence` row for a seat   | `latestAttestedModel` — newest non-held row, `model` may be null       | `currentAttestedModel` — same table, `AND model IS NOT NULL`                              | a born-null ambient row shadows a held attested one → the seat grades `unknown` and leaves the ADR 188 pool | ryder                   |

Instance 6 has a live consequence worth stating separately, because it silently corrupts a published
number: at the moment ryder queried, miley and wanderer were **both** out of the cross-family
candidate pool and neither had any way to know. **Any ADR 188 candidate-pool figure quoted on
2026-08-05 is low by an unknown amount.** (Both function bodies were verified on `origin/main` when
this was written — `review.ts` and `presence.ts`; the line numbers move, the shapes do not.)

### What instance 5 adds that 1–4 did not

In instances 1–4 the shared thing is a **stored or passed value**, and the first consumer's code
merely _reads as complete_ at its call site. In instance 5 the shared thing is a **transform**, and
the erasure is deliberate, documented, and correct for its first consumer: ADR 153 argues explicitly
for lifting git's pre-subcommand globals so that an obvious `git merge*` rule catches
`git -C ../main merge`. dolly's question was scope, and `-C` is exactly the token that answers it.

So the second consumer's author can open the helper, find a doc comment explaining precisely why the
token is lifted, conclude it is working as intended — and still be wrong, because "working as
intended" was scoped to a question they were not asking.

> **A documented transform is more dangerous than an undocumented one, because the documentation
> terminates the investigation.**

## Problem

One value or transform, two consumers, opposite needs — and **the second consumer is invisible from
the first's call site.**

The first consumer is correct in isolation. The second is not merely elsewhere in the file; it is
elsewhere in the system, reached by a path the first author had no reason to open. Positive tests
exercise the first consumer's case and stay green, because the first consumer's case is the one
everybody had in mind. Review keeps missing it because there is nothing wrong to see at either site.

## Decision

**1. The class gets a number, and 225 keeps only what is its own.** This ADR carries the statement,
the instance table, the signature, and the corollaries. ADR 225's `## The shared-predicate trap`
becomes a short pointer that retains instance 3 — the one that is genuinely that ADR's thesis — and
its sibling section on convenient fixtures, which is about tests rather than about consumers. A
number is what a code comment can cite; that is the point of moving.

**2. The mechanical signature — dolly's, and the most useful line here.** It converts a pattern you
must already know about into something a reader can search for:

> **When a helper documents why it throws something away, that discard is a precondition on its
> consumers, not an implementation note** — and the consumer list should be enumerable before the
> next consumer is added.

`normalizeCommand`'s doc comment says "identity-neutral passes" and "lifted off": it advertises the
erasure, proudly and correctly. That advertisement is the tell. Grep for helpers whose documentation
explains a discard, then count their callers.

**3. The check, both clauses.** Before adding a consumer to a shared value or transform:

> _What wrote this row, and **who else reads it**?_

**4. The citation is a smell — distinct from a thin fixture, and one rung worse.** dolly's match list
did not merely fail to cover the failing case; it **asserted the defect as correct, citing ADR 153 by
name** as its justification.

> A test that cites an ADR to justify an assertion inherits that ADR's _purpose_, and purpose does
> not transfer across consumers. **When a test cites an ADR as its reason, check that the ADR's
> question is your question.**

153's question was classification; hers was scope. The citation is precisely what stopped her
looking.

**5. A guard that never instantiates the second consumer's case is decoration.** In instances 1–3 the
negative tests caught it — ryder's first cut turned four tests red because the paid rail had its own
assertions. Instance 4 had no negative test, and worse, had a guard that looked like one:
`reconcile.test.ts`'s round-trip fixed-point test is exactly the invariant multi-role seats violate,
and it passes because its fixture holds two single-role seats. It is well-named, well-intentioned,
and **green for the entire life of the bug.** A round-trip guard proves nothing about a field its
fixture never populates.

**5a. The same shape one altitude up: a redundant rule that looks load-bearing.** Mutation testing on
dolly's matcher (ADR 239) found that of its rules only four are load-bearing; three — the separated
`-C`/`--git-dir` forms, the `--` separator, and the special case for `.` — reduce to the bare-token
rule or the subcommand check, and their mutants survive. She recorded that instead of tidying it
away, so the next editor knows which rule they are actually leaning on. A rule that appears to guard
the invariant, but whose removal changes nothing, is decoration with a different costume.

**6. Widening a predicate makes its key a capability.** Once `pendingInterrupts` admits an obligation
class, whatever field selects that class decides who can raise another seat's interrupt line — so
`meta.lane_review` had to become server-controlled. **The new admission key inherits the trust
requirements of the rail it opens.**

**7. The remedy is not to widen the predicate until it satisfies everyone.** It is to make the second
consumer explicit and let each rail state its own need. That is what shipped for instance 3:
`obligations` is opt-in and off by default, the free rail passes `{ obligations: true }`, the paid
rail calls the same function bare and keeps its gate. One predicate, two call sites, opposite
defaults, each legible where it is used. For instance 4 the equivalent is for the exporter to emit
what the reader treats as authoritative — not for the reader to start guessing from the singular
field. For instance 6 it is two named accessors with their null semantics in their names, not one
that quietly serves both.

**8. Findability, since that is the actual complaint.** The signature and the check go into
`docs/architecture/07-conventions.md`, which is read while coding, with this ADR as the case law.
And a helper that documents a discard should cite this ADR at the discard, so the next consumer meets
the precondition where they are already reading.

**9. No lint gate, deliberately — for now.** "A helper whose doc mentions discarding, with more than
one caller" is a plausible check and a speculative one; its false-positive rate is unmeasured, and
ADR 239 is a live demonstration of what a warn-rail with a bad rate costs. The signature ships as
prose and a grep. If someone wants the gate, they owe a measured rate first.

## Consequences

- Inbound references to ADR 225's trap section still land: the section survives as a pointer with the
  instance that belongs to it. Nothing is orphaned.
- The class costs a number (247) and the ADR 223 reservation ritual. That is the price of being
  citable from a code comment, which was the goal.
- Instance 6 is documented but **not fixed here** — this is a docs ADR. The null-semantics split in
  `latestAttestedModel` / `currentAttestedModel` is ryder's lane (01KZ9W0R29), and the ADR 188 pool
  numbers from 2026-08-05 stay suspect until it lands.
- Two seats' work is now cross-referenced rather than merged: dolly keeps ADR 239's own correction
  section, this ADR keeps the generalization. Duplication is deliberate and small.

## Observability & Evaluation

**Traces.** None. This ADR adds no code path, emits no act, and stores no row — it is a named defect
class and a review check. Deliberately choosing prose over a gate (decision 9) means the only
instrument is citation: instances of this class are recorded in the table above, and a new one is
added by amendment.

**Eval.** The metric is **rediscovery cost**: how a seat meets the class the first time. Baseline,
measured on 2026-08-04 to 2026-08-06 and the reason this ADR exists — six instances, four seats, and
in every case the class was met by _hitting it_, never by reading it. Three of those seats were
working in subsystems (a git hook, a wake path, a roster serializer) from which no plausible chain of
references leads to an ADR about acceptance. The dataset is the instance table; the unit of
observation is one new instance and the answer to a single question asked of whoever finds it: **did
you know the class before you hit it, and where from?** Post-ADR the intended answer is
`07-conventions.md`, or a citation at a discard, and not "I rediscovered it."

**Experiment.** None run. The comparison this ADR would need — findability with the class in an
acceptance ADR versus in conventions — is unrunnable after the fact and not worth staging. What is
falsifiable is the claim behind decision 8: **if the next instance is again found by hitting it, and
its finder reports never having read the conventions entry, then relocation was not the remedy and
the honest next move is the lint gate decision 9 declined** — with its false-positive rate measured
first. Two more cold rediscoveries after this lands is the threshold; one is noise, given how few
seats are looking. The counter-claim is equally testable: a single instance caught _at review_ by
someone asking "who else reads it" is the outcome the whole document is for, and should be recorded
in the table with that provenance.
