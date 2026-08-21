# Longitudinal watches — design

- Lane: `01M0ER03RJ2WZRD377FTNQCDP5` (opened by dolly, claimed by izzo)
- ADR: 297 (reserved, PR #965)
- Date: 2026-08-21
- Status: design approved in chat by nick, 2026-08-21

## The problem, measured

A measurement over days needs a window. We have no primitive for one, so days-long questions get
answered by installing a recurring sweep and hoping someone reads it. Nobody reads it.

The instrument that proves this is our own. `scripts/research/adr-166-slot-sweep.ts` has run every
five minutes since 2026-07-27 under a `StartInterval` LaunchAgent:

| | |
| --- | --- |
| sweeps | 5,679 |
| window | 2026-07-27 → 2026-08-21 (24.8 days) |
| size | 49.5 MB (`~/.musterd/research/adr-166-slot-sweep.jsonl`) |
| workspace-observations | 323,682 |
| times read | 0 |

The lane asking someone to read it — `01KYJXFXEM5EGAVC4HETG15SZJ`, *"decide whether the instrument
earns its keep"* — has been open and unowned for 25 days.

Two distinct failures live in that series, and separating them is what motivates the whole design.

### Failure one — the pre-registered target was breached, loudly, and nobody looked

ADR 166 eval item 3 pre-registers `demoted` at target **ZERO** and calls any instance a finding
requiring inspection of the workspace. It is not zero:

| | |
| --- | --- |
| demoted observations | 109, across 105 samples, on 6 distinct days |
| by workspace | `agents-wanderer` ×75, `agents-gptbot` ×20, `agents-kimi` ×8, `agents` ×5, `agents-ryder` ×1 |
| cluster | 80 of 109 fell on 2026-08-12/13 |

**And the instrument was not silent.** `adr-166-slot-sweep.ts` sets `process.exitCode = 1` on any
demote (line 171), writes to stderr, raises `adr166-demoted-*` into `musterd report` until it
clears, and fires an OS push on a repeat (lines 161–171). `sweep.log` holds **214** `DEMOTED` lines,
many of them `DEMOTED(repeat)`.

So the failure is worse than "nobody read the file." The escalation path fired for 25 days and not
one case was inspected. An instrument that escalates into a channel with no owner is not
observability; it is an alarm wired to a bell in an empty room. **A watch names an accountable seat
and a date. A sweep names neither** — which is the whole difference.

### Failure two — the rates in the same series cannot be read at all

Anything computed as a *rate* over this window is uninterpretable, because the denominator moved:
distinct sampled workspaces swung **23 → 196 → 9** inside it. A percentage spanning that is three
populations wearing one number.

This is the contamination `windowGuard()` in `scripts/research/adr-260-acceptance-eval.ts:241`
already refuses to report through, for exactly one hardcoded question. ADR 166's sweep had no such
guard, so it accumulated 49 MB of ambiguity silently.

### The design lesson the two failures give together

The target-zero *count* survived the population swing; the *rates* did not. A question phrased so
its answer is invariant to a moving denominator is worth more than one that is not — and you can
only choose that phrasing **before** collection. That is a `falsifier` rule, and it is in §1.

> This spec's author demonstrated the point the hard way: I first read the sweep's `dangerous` field
> as a regression signal and broadcast it. `dangerous` is set on `disagreed && state === 'live'` and
> the script labels it `caught-by-flip` — it counts the fix *working*. Self-corrected in ~20 minutes;
> entry minted at `docs/claims/entries/2026-08-21-adr-166-dangerous-misread.md`. A field name is not
> a definition, and a rate invites a story a count would have refused.

The motivating evidence is also in the record: ADR 294's retrospective cut found the two costliest
false claims in its window (vitest known-noise, 7d; ADR 272's unmet gate, 5d) were both
`absence`-class and both survived *because nothing was scheduled to re-look*.

## The contrast the design encodes

| | ADR 260 re-run | ADR 166 sweep |
| --- | --- | --- |
| question stated before collection | yes | no |
| falsifier stated before collection | yes | no |
| guard against a contaminated window | yes (`windowGuard`) | none |
| resolution posts back | yes (to the ADR) | never |
| dies | yes, one shot | never |

The first is a **watch**. The second is the recurring background extraction nick ruled out as a
design constraint. The primitive's job is to make the first cheap and the second impossible to do by
accident.

## Non-goals

- Not a scheduler, not a daemon, not a server table. A watch is a file and a gate.
- Not a general telemetry or retention system.
- Not licence for recurring background extraction. A watch is finite, question-scoped, and dies at
  its resolution (nick's constraint, 2026-08-19/20 design conversation).
- Increment 1 does not retrofit watches onto other running instruments (`musterd-sweep`,
  `otel-sink`, `streamwatch`), and adds no `team_next` or server-side surfacing.

## 1. The watch record

One file per watch: `docs/watches/<opened>-<slug>.md`, sibling to `docs/claims/entries/`. YAML
frontmatter is what the gate reads; the prose body argues why the question needs a window.

    ---
    question:   <the question, phrased so an answer settles it>
    claim_ref:  <path to the decision/wiki page whose truth depends on the answer>
    falsifier:  "<what observation would change the answer — stated BEFORE collection>"
    population: <what is being sampled, explicitly>
    void_if:                       # the window guard, stated BEFORE collection
      - <condition that disqualifies the window>
    series:     <where samples accumulate>
    cadence:    <sampling interval>
    opened:     <YYYY-MM-DD>
    opened_by:  <seat>
    revisit_by: <YYYY-MM-DD>
    status:     open               # open | resolved | void
    resolution:                    # REQUIRED once status != open
    ---

    <prose: why this question needs a window rather than a moment.>

### Field rules

| field | rule |
| --- | --- |
| `question` | must be answerable; a topic is not a question |
| `claim_ref` | must be an existing path in the repo — this is the post-back target |
| `falsifier` | must be able to fail (wiki rule 3). A falsifier satisfied either way is not ready to merge. **Prefer a target-zero count over a rate** — see below |
| `population` | names the sampled set, so a change to it is detectable |
| `void_if` | at least one condition. A watch with no way to be void is claiming its population is immutable |
| `series` | where samples land, so the watch is findable from the data and vice versa |
| `opened_by` | the seat accountable for resolving it; named in Rule A's failure message |
| `revisit_by` | after `opened`; **cannot be moved forward on an existing watch** |
| `resolution` | required when `status` is `resolved` or `void`; free prose naming the verdict |

### Phrasing the falsifier: prefer a target-zero count over a rate

A rate needs a stable denominator; a count with target zero does not. ADR 166 carried both, over the
same 24.8 days and the same collapsing population — the `demoted` count stayed readable and produced
a finding, while every rate in the same file became uninterpretable.

So when a question admits both phrasings, take the count:

| prefer | over |
| --- | --- |
| "any instance of X is a finding" | "the rate of X stays under n%" |
| "zero occurrences over the window" | "occurrences trend downward" |

This costs nothing at authoring time and cannot be retrofitted after collection, which is precisely
why it belongs in a pre-registration rule rather than in analysis guidance. Where a rate is genuinely
the question, `void_if` must name the population conditions that disqualify it — that is what the
field is for.

### What the gate does and does not evaluate

The gate is a **schema and lifecycle** check. It verifies that a watch is well-formed, that it has
not outlived its date, and that its resolution posted back. It does **not** evaluate `void_if` or
`falsifier` against the series — those are prose conditions, and judging them is the resolver's
work, the same way the claims ledger's `falsifier` field is judged by a reader rather than executed.

A watch may additionally ship an executable guard (ADR 260's `windowGuard()` is one), and where it
does, the resolver runs it. Increment 1 does not generalise that into a plugin interface; it is
enough that the guard's *conditions* are written down before collection, because that is the part
ADR 166 lacked.

### Lifecycle

`open` → `resolved` (the question got an answer) or `void` (the window was disqualified, or nobody
looked). Both are terminal. There is no third state and no renewal.

**A watch cannot be renewed in place.** `revisit_by` is immutable once merged; continuing a question
means a *new* watch file, with a new question, in a diff someone reviews. This is the mechanism that
prevents recurring background extraction: renewal costs a decision instead of being the default.
ADR 166's sweep renewed itself 5,679 times for free.

**`void` is a real outcome, not a failure.** A watch that expires unread resolves as
`void: unattended — revisit_by passed with nobody reading the series. No verdict.` That records that
we failed to look, which is the datum ADR 294 wants and the thing ADR 166's sweep hid for 25 days.

### Relationship to the controls registry

`docs/controls/registry.ts` tracks whether a guard is *in force* — `lastExercised` (a moment) and
`everTripped` (efficacy). A control whose efficacy is a **rate** cannot be settled by a date; ADR
227's infra-touch gate is the live instance, where the warn→redirect rate was *"unmeasurable as
built"* (lane `01M0GX9VD7`).

Watches do not duplicate the registry. Increment 1 adds one optional field:

    /** The watch measuring this control's rate, when a date cannot settle its efficacy. */
    watch?: string;

## 2. The gates

`scripts/check-watches.ts`, wired into `format:check` as `watch:check`, following the house pattern
of `check-controls.ts` and `check-wiki.ts`. Three rules, deliberately scoped differently.

### Rule A — no watch outlives its `revisit_by` (tree check)

An `open` watch past its `revisit_by` fails the build.

A calendar-triggered gate reddening an unrelated PR is a real hazard — it is the "main is RED"
false-defect class in the ledger. It is accepted here because **the precedent is already in force
and was accepted**: `check-controls.ts` hard-fails on `staleAfterDays` from `format:check` today,
and its stated escape is *"raise `staleAfterDays` with a reason in the PR. Both leave a record;
ignoring it does not."* Watches inherit that rule verbatim rather than inventing a gentler one.

The escape is one line, and it is honest rather than a workaround — marking a watch
`void: unattended` records the failure to look. The gate is unignorable; the cheapest way out tells
the truth.

The failure message names the watch's opener and states that voiding is legitimate, so a stranger
who hits it knows both who to ask and that the one-line fix is not a dodge.

### Rule B — the frequency-adverb rule (diff check, NEVER a tree check)

A `## Decision` section asserting a frequency claim must carry a `Snapshot-debt:` header line.

`check-change-adr.ts:176` already documents the trap: making that gate a tree check *"would fire on
every PR touching one of those 94."* Measured on this corpus: **14 of 292** existing ADRs carry a frequency term inside their
`## Decision`. That is not most of them, but it is 14 failures an author cannot fix on a PR that
touched none of them — which is how a gate gets switched off. So Rule B reuses `check-change-adr.ts`'s base resolution
(`--base` → `$CHANGE_ADR_BASE` → `origin/main`, compared at the merge-base) and its existing
`## Decision` body extractor at line 142. It judges only what the branch changed, and only inside
`## Decision`, where an assertion is being made rather than history quoted.

Word list — strictly frequency of a time-varying quantity:

    flaky, intermittent, intermittently, rare, rarely, usually, often, frequently,
    occasionally, sometimes, sporadic, sporadically, "under load", "most of the time"

Deliberately **not** `always` / `never`: those are `absence`-class claims, they are ubiquitous in
prose, and they are the controls registry's problem, not this one.

Satisfied by one header line, mirroring `Status:` and `Date:`:

    Snapshot-debt: docs/watches/2026-08-21-adr-166-slot-disagreement.md
    Snapshot-debt: none — quoting ryder's #912 measurement, not asserting it here

### Rule C — a resolution must post back (diff check)

A diff that moves a watch to `resolved` or `void` must also modify the file named in its
`claim_ref`.

Without this the protocol has no teeth: a verdict that lands only in `docs/watches/` is a verdict
nobody reads, which is the failure being fixed. Rule C forces the answer back onto the decision that
depended on it, as a dated note in the wiki rule-4 shape. This is dolly's *"a resolution that posts
back to the lane that asked."*

## 3. The decision protocol (ADR 297)

One rule, deliberately mirroring the claims ledger's.

> The ledger says: **the corrector mints, riding the act they are already performing.** Never a
> sweep, never a patrol.
>
> ADR 297 says: **the decider opens the watch, riding the act they are already performing** —
> writing the decision.

When a decision rests on an n=1 snapshot of a time-varying quantity, it carries `Snapshot-debt:`
naming a watch, and the watch carries the revisit-by. Days-later wrongness becomes scheduled
detection instead of luck.

Rule B is the enforcement; ADR 297 is the doctrine and the reasoning.

## 4. Exercising it on ADR 166

A primitive with zero instances is itself an untested `absence`-class claim, so increment 1 ships
its first real application.

The exercise is unusually good for the purpose because ADR 166's series demonstrates **both**
terminal states at once — one question resolves, the other voids, over identical data.

1. Open **two** watches against the series, because it carries two questions:
   - `docs/watches/2026-08-21-adr-166-demoted.md` — ADR 166 eval item 3's target-zero count.
   - `docs/watches/2026-08-21-adr-166-disagreement-rate.md` — the rate question, carrying the
     `void_if` population guard the sweep never had.
2. Resolve both from the existing 24.8-day series:
   - The **count** watch resolves `resolved` with a real verdict: target zero is breached, 109
     instances, 6 days, `agents-wanderer` ×75. Its `void_if` guard passes, because a target-zero
     count does not depend on the denominator.
   - The **rate** watch resolves `void: population unstable` — distinct-seat count moved
     23 → 196 → 9, past any sane bound — and its numbers are **not** published as a trend.

   Two watches, same data, opposite outcomes, for a reason stated before collection. That contrast
   is the demonstration, and it is worth more than either watch alone.
3. Dated amendment on ADR 166 recording that eval item 3 is **breached and uninspected** since
   2026-08-03. ADR 166 is `draft`, so the immutability gate (which guards `accepted` ADRs) does not
   apply.

   **No claims-ledger entry against stanley.** ADR 166 set a target and an inspection obligation; an
   unmet obligation is not a falsified claim, and the ledger is for claims. Its *"0 demoted"* line
   describes a specific case at the moment of flipping, not a standing prediction. If inspection
   later shows the flip is harmful, ADR 166's decision has a falsified premise and whoever finds
   that mints it then. Minting one now would be exactly the "no bare rates / no scoreboard" abuse
   ADR 294 decision 4 forbids.
4. Open the **successor watch** for the count — same question, stated stable population, real
   `revisit_by`, `opened_by` naming an accountable seat. This hands lane `01M0JNYJ4K` a
   properly-formed instrument instead of 49 MB of ambiguity, and gives the escalation path an owner
   so the next 109 instances reach a person.

**The LaunchAgent is not stopped.** Killing collection is an infra touch on nick's machine and the
wrong move regardless — the successor watch needs the series to continue. The outcome is a sweep
that is *bounded*, not dead: same cadence, now with a stated void condition, a death date, and a
retention bound (~2 MB/day on a laptop that runs tight on disk).

## Testing

`scripts/check-watches.test.ts`, TDD, matching the existing `scripts/check-*.test.ts` pattern.

| rule | cases |
| --- | --- |
| schema | missing required field; `revisit_by` before `opened`; empty `void_if`; `claim_ref` pointing at a non-existent path; `resolution` absent when `status != open` |
| Rule A | open watch past `revisit_by` fails; same watch `void` passes; watch inside its date passes |
| Rule A | `revisit_by` moved forward on an existing watch fails (immutability) |
| Rule B | frequency adverb in `## Decision` without `Snapshot-debt:` fails; with either satisfying form passes; same adverb in `## Context` passes; adverb in an ADR the diff did not touch passes (the tree-check trap) |
| Rule C | watch → `resolved` without touching `claim_ref` fails; touching it passes |

The Rule B "adverb in an untouched ADR passes" case is the important one — it is the regression test
for the trap `check-change-adr.ts:176` documents.

## Increment 1 scope

Schema, `docs/watches/`, three gate rules with tests, ADR 297, one optional `Control.watch` field,
and the ADR 166 exercise (two watches, one resolved and one void, ADR amendment, successor watch).
