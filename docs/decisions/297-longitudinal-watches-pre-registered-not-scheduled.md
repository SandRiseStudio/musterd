# 297 — Longitudinal watches: a measurement over days is a pre-registered question, not a scheduled sweep

- Status: proposed
- Date: 2026-08-21. Authored by izzo (lane `01M0ER03RJ2WZRD377FTNQCDP5`).
  Number **297 reserved** by a stub pushed before the ADR was written, per ADR 223.
- Builds on: [ADR 294](294-false-claims-ledger.md) (the claims ledger, whose mint-at-correction rule this
  ADR mirrors on the other side of the clock), [ADR 002](002-dependencies.md) (why the parser is
  hand-written), [ADR 260](260-live-acceptance-pick-skips-busy-agents.md) (whose re-run is the one
  well-formed instance that already existed), [ADR 166](166-session-liveness-by-enumeration.md)
  (whose sweep is the counter-example, and the first watch's subject).
- Snapshot-debt: none — every number below is a count over a fixed series, not a rate, and the two
  watches this ADR ships carry the population conditions for their own windows.

## Context

Some questions cannot be answered at a moment. "Is this flaky?", "did the fix hold?", "does the
guard still catch anything?" are all claims about a quantity that varies over time, and a single
observation of a time-varying quantity is a claim about the conditions it ran under — not a general
statement.

We had no primitive for that. So days-long questions got answered the only way available: install a
recurring sweep, and hope someone reads it.

## Problem

Nobody reads it. Measured on our own instrument, `scripts/research/adr-166-slot-sweep.ts`, running
every five minutes since 2026-07-27 under a `StartInterval` LaunchAgent:

| | |
| --- | --- |
| sweeps | 5,682 |
| window | 2026-07-27 → 2026-08-21 (24.8 days) |
| size | 49.5 MB |
| workspace-observations | 323,682 |
| times read | 0 |

The lane asking someone to read it (`01KYJXFXEM`, *"decide whether the instrument earns its keep"*)
sat open and unowned for 25 days. Two distinct failures live in that series.

**One — the pre-registered target was breached, loudly, and nobody looked.** ADR 166 eval item 3
pre-registers `demoted` at target ZERO and calls any instance a finding requiring inspection. It is
**109**, across 105 samples on 6 days (`agents-wanderer` ×75, `agents-gptbot` ×20, `agents-kimi` ×8,
`agents` ×5, `agents-ryder` ×1). And the instrument was **not silent**: it sets `process.exitCode = 1`
on any demote, writes 214 `DEMOTED` lines to `sweep.log`, raises `adr166-demoted-*` into
`musterd report` until it clears, and fires an OS push on a repeat.

So the failure is worse than "nobody read the file." The escalation path fired for 25 days and not
one case was inspected. **An instrument that escalates into a channel with no owner is not
observability; it is an alarm wired to a bell in an empty room.**

**Two — the rates in the same series cannot be read at all.** Distinct sampled workspaces swung
23 → 196 → 9 inside the window. Any percentage over it spans three populations. This is the
contamination `windowGuard()` in `scripts/research/adr-260-acceptance-eval.ts:241` already refuses
to report through — for exactly one hardcoded question. ADR 166's sweep had no such guard, so it
accumulated 49 MB of ambiguity silently.

ADR 294's retrospective cut supplies the motive independently: the two costliest false claims in its
window (vitest known-noise, 7 days; ADR 272's unmet gate, 5 days) were both `absence`-class and both
survived *because nothing was scheduled to re-look*.

## Decision

**A days-long measurement is a watch: a pre-registered question with an owner and a death date.**

A watch is one file in `docs/watches/`, stating — before collection starts — the question, the
falsifier that settles it, the population sampled, the conditions that disqualify its own window,
where samples accumulate, who is accountable, and the date by which it must resolve. It ends
`resolved` (a verdict) or `void` (the window was disqualified, or nobody looked). Both are terminal.

Four rules carry the weight.

**1. The decider opens the watch, riding the act they are already performing.** ADR 294 says *the
corrector mints, riding the act they are already performing* — never a sweep, never a patrol. This
is that rule on the other side of the clock: when a decision rests on a snapshot of a time-varying
quantity, the person writing the decision opens the watch, in the same diff. Enforced by the
`Snapshot-debt:` header and the frequency-adverb gate.

**2. A watch cannot be renewed in place.** `revisit_by` is immutable once merged. Continuing a
question means a NEW file, a new question, a new diff someone reviews. **Renewal must cost a
decision, because free renewal is the disease** — ADR 166's sweep renewed itself 5,682 times for
nothing.

**3. `void` is an honest outcome, not a failure.** A watch that expires unread resolves
`void: unattended — revisit_by passed with nobody reading the series. No verdict.` That records that
we failed to look, which is the datum ADR 294 wants and precisely what ADR 166's sweep hid.

**4. Prefer a target-zero count over a rate.** A rate needs a stable denominator; a count with
target zero does not. ADR 166 carried both over identical data and a population that swung
23 → 196 → 9: the count stayed readable and produced a finding, every rate became uninterpretable.
This choice costs nothing at authoring time and **cannot be retrofitted after collection**, which is
exactly why it is a pre-registration rule rather than analysis guidance.

The gate (`scripts/check-watches.ts`, in `pnpm format:check`) enforces schema, a tree rule that no
watch outlives its `revisit_by`, a diff rule that a `## Decision` asserting a frequency claim cites
a watch or waives it with a reason, and a diff rule that a resolution touches its `claim_ref`.

**This is not licence for recurring background extraction.** A watch is finite, question-scoped, and
dies at its resolution. That constraint is nick's, from the 2026-08-19/20 design conversation, and
rules 2 and 3 exist to make it structural rather than cultural.

## Consequences

- Rule A breaks the build on a date rollover with no code change. That is inherited deliberately
  from `check-controls.ts`, which already does exactly this from `format:check`. The pressure valve
  is one honest line, and taking it leaves a record.
- The frequency-adverb rule is diff-scoped and must never become a tree check. Measured 2026-08-21:
  14 of 292 existing ADRs carry a frequency term in their `## Decision`. Not most — but 14 failures
  an author cannot fix, on a PR that touched none of them, is how a gate gets switched off.
  `check-change-adr.ts:176` already records this lesson from the other side.
- `docs/controls/registry.ts` gains an optional `watch` field. A control's `lastExercised` answers a
  moment; some controls' efficacy is a rate, and ADR 227's infra-touch gate is the live instance
  where the warn→redirect rate was "unmeasurable as built".
- The gate sees committed changes only (`base...HEAD`), matching `check-change-adr.ts`. Staged work
  is judged once committed.

## Observability & Evaluation

Pre-registered, because an ADR about pre-registration that pre-registers nothing would be the joke
telling itself. Assessed **2026-11-01**:

1. **Has any watch been opened by a seat other than izzo?** Target: at least one. A primitive only
   its author uses did not become a practice, whatever its merits.
2. **Has any watch resolved with a verdict rather than `void: unattended`?** Target: at least one.
   All-void would mean we built a more honest way to record that nobody looked, which is worth
   something but is not what this is for.
3. **How many `Snapshot-debt:` lines are watch citations vs. waivers?** No target — this is
   descriptive. A corpus of nothing but `none — …` waivers is the signal that the adverb rule is
   being routed around rather than used, and rule 1 has failed.

## Falsifier for this ADR's premise

The premise is that scheduled collection without a pre-registered question and a death date goes
unread, and that pre-registration is what makes the difference.

It is falsified if, by the 2026-11-01 checkpoint, watches are being resolved no more reliably than
the ADR 166 sweep was read — i.e. if the watch corpus is majority `void: unattended`. That outcome
would say the problem was never the missing question; it was that nobody had time, and a schema
does not create time.
