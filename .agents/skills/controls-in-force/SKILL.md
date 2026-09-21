---
name: controls-in-force
description: Every guard you believe is protecting you carries the date someone last watched it work, whether it has ever actually caught anything, and an honest answer to "would it have caught the incident that motivated it?" — with a hundred-line checker that fails the build when the evidence goes stale. Use when adopting a guard you did not write, when a gate has been green a suspiciously long time, or when someone cites a control as satisfied.
---

# controls-in-force

*One of three thin instruments from [dated-and-falsifiable](../dated-and-falsifiable/SKILL.md).
Each is a file convention plus a script of about a hundred lines; each works alone,
on one machine, with no server. They share one rule: **a record must be able to
fail.** If the check passes just as happily when the claim is wrong, it is a
ritual, not an instrument.*

**An unexercised control is indistinguishable from a broken one.**

Four unrelated failures on one day turned out to be a single failure — a guard
everybody believed was in force that was not:

- A test-timeout ceiling that reached **zero of five packages**, because a
  package-local config inherits nothing. The limit everyone believed was
  protecting the whole-repo run was protecting one command nobody ran before
  pushing. It had been read as "known flaky-test noise" for a week.
- A health probe that ate its own errors in a bare `catch {}`: 22 alerts, one
  distinct message between them, none diagnosable afterwards.
- A decision that cited a measured gate as satisfied. The gate had **never
  fired** — zero matching rows, ever. Five days of a decision resting on an
  unmet precondition.
- A falsifier that could not fail, satisfied equally by the defect and by its
  absence.

Every one of those is an **absence claim**: an assertion that something is being
prevented. Absence claims have the longest half-life of anything you can write
down, because nothing contradicts them. Nobody wakes up to a guard quietly not
guarding.

## The two facts, and why conflating them is the bug

- **Exercised** — when did someone last *run* this and watch what it did? That
  is **liveness**.
- **Tripped** — has it ever actually *caught* anything? That is **efficacy**.

Neither substitutes for the other, and a registry that records only one will
mislead you in a predictable direction.

A control exercised often and never tripping may be guarding something that
cannot happen. That is fine, and it is worth knowing — it tells you the guard is
cheap insurance rather than load-bearing. A control that tripped once and has not
been exercised since may have rotted, and *that* is invisible without a date.

## The counterfactual rule

Every entry answers one question: **would this control have caught the incident
that motivated it?**

The rule is not rhetorical, and **"no" is a passing answer.** A control that
admits it would have missed is more useful than one nobody ever asked, because
now you know what you still do not have.

It has teeth because it has been paid. Applied honestly to a freshly built check,
the answer was that it would have passed on the very case that prompted it — so
the check was thrown away rather than shipped as reassurance. **Decoration that
reads as protection is worse than nothing**, because it stops the next person
looking.

## The registry

`controls.json` is an array. Every field earns its place:

```json
{
  "id": "test-timeout-parity",
  "kind": "timeout",
  "claim": "Every test config runs at the same measured timeout, so a slow test fails the same way under a single-package run and a whole-repo run.",
  "where": "vitest.shared.ts, imported by the root config and all five package configs",
  "exercise": "Drop the shared import from any package config and set its own timeout; tests/config-parity.test.ts must fail. Independently: a test that sleeps 6s fails at the 5s default and passes at the shared ceiling.",
  "motivated_by": "2026-08-19: the root config's 30s ceiling reached zero of five packages. Read as flaky-test noise for a week. Baseline 2/20 full runs failed by timeout; with the fix 0/20.",
  "counterfactual": "Yes, and measured rather than argued: the parity test fails on the exact pre-fix configuration.",
  "last_exercised": "2026-08-19",
  "ever_tripped": true,
  "last_tripped": "2026-08-19",
  "stale_after_days": 90,
  "refs": ["PR #918", "tests/config-parity.test.ts"]
}
```

Three of those fields are where the discipline actually lives.

**`claim`** — write it as the sentence someone would *rely on*, not as a
description of the code. "Validates the payload" is a description. "No request
reaches the handler with an unparsed body" is a claim, and you can tell when it
stops being true.

**`exercise`** — concrete enough for a stranger to run. **"It's covered by
tests" is not an exercise**; naming the test and the edit that makes it fail is.
Two things generalise from doing this for real:

- **Fire the control, not the action it guards.** One of ours had an `exercise`
  field that opened with "restart the shared service" — which would have dropped
  every live session on the machine. But the control itself was a read with no
  side effect; the destructive verb was merely what *followed* it. Fire it
  directly and leave the service alone. A control whose exercise instruction
  reads as "cause the incident" usually has a cheaper handle, and finding it is
  part of the exercise.
- **Say which branch you fired, and from where.** Some controls have branches
  only reachable from a particular role or environment — a privileged identity
  gets the silence branch by design and *cannot* produce the warning. Claiming a
  branch you could not have reached is the easier write-up and a false one.

**`stale_after_days`** — choose it from how fast the thing underneath moves, not
from a default. A control over a file edited weekly rots faster than one over a
shipped protocol.

## The checker

```sh
./controls.py [controls.json]
```

Exit 0 when every control's evidence is current, 1 when one is not, 2 when the
file cannot be read. Python 3.8+, standard library only — no install step.

| Rule | What it refuses |
| --- | --- |
| exercised **xor** never | Both, or neither. An absent field means "never" *and* "nobody said", and no check can tell those apart. |
| a declared absence is dated | `never_exercised` without `never_exercised_since`, which would be a permanent staleness exemption. |
| dates are real | Non-ISO, impossible calendar dates, and dates in the future — a future date pushes a control permanently out of staleness. |
| tripped **⟺** dated | "It has caught things" with no date is the exact unfalsifiable shape this exists to stop. |
| the counterfactual is answered | A stub. "No" passes; three words do not. |
| not stale | Evidence — an exercise date **or** a declared absence — older than the control's own bound. |

### A declared absence expires

`never_exercised` is legal and honest. What it must not be is free. Our first
version skipped staleness for it on the reasonable grounds that there was no
date to age — which made the stated reason a **permanent exemption**, and the
warning line wallpaper. The registry's own thesis, turned on itself, inside the
registry. So the absence carries its own start date and ages against the same
bound, and the countdown prints on every green run so the expiry is visible
before it fails anything:

```
ok controls: 2 registered, all exercise evidence current -- 1 never exercised, 1 never tripped
  ! infra-touch-warning -- never exercised (45d until this expires): Registered from the
    code and the incident report; nobody has fired it deliberately since it shipped.
```

### Rule 5 can break your build on a date rollover with no code change

That is uncomfortable and it is the design. **A liveness check that cannot fail
on its own is precisely the disease.** The pressure valve is honest rather than
silent: re-exercise the control and move the date, or widen `stale_after_days`
with a reason in the commit message. Both leave a record; ignoring it does not.

## Two things this does *not* do

Say both out loud where the registry lives, or you have built a new absence claim
one level up.

**It does not find controls.** There is no discovery of guards in your tree, so
the registry is a **floor, not an inventory**. An entry lands when someone
exercises a control and records what they saw. Claiming completeness on day one
would be the same lie in a nicer format.

**It does not discover exercises either, and that is the sharper half.** One of
ours was registered "never exercised" on a day when it had in fact been fired
against production sixteen days earlier — by someone who wrote up what they saw
somewhere else entirely. So `never_exercised` means *nobody wrote it here*, not
*nobody did it*: an absence claim about an absence-class instrument, reached by
reading the wrong record. The countdown would have failed the build for a control
exercised two weeks before it was registered.

## The falsifier, and a trap inside it

A checker whose failure paths have never run is an unexercised control. Shipping
one from *this* file would be absurd, so:

**Falsifier — break each rule and watch it fire.** Copy
`controls.example.json`, mutate one field, run `./controls.py` on the copy. All
eighteen refusals below were exercised this way on 2026-09-21 against the
shipped script; a rule you cannot make fire is a rule that does not work.

| Mutation | Expected |
| --- | --- |
| add `never_exercised` beside `last_exercised` | exit 1, "must declare exactly one" |
| delete `last_exercised` | exit 1, same |
| set `never_exercised` to `"tbd"` | exit 1, "not a placeholder" |
| delete `never_exercised_since` | exit 1, "an undated absence never expires" |
| add `never_exercised_since` to an exercised control | exit 1, "they travel together" |
| `last_exercised: "2026-02-31"` | exit 1, "must be a real ISO date" |
| `last_exercised: "19/08/2026"` | exit 1, same |
| `last_exercised: "2099-01-01"` | exit 1, "is in the future" |
| delete `last_tripped` from a tripped control | exit 1, "an undated catch is unverifiable" |
| add `last_tripped` to an untripped one | exit 1, "they disagree" |
| `counterfactual: "yes"` | exit 1, "a stub is not" |
| `stale_after_days: 1` on an aged exercise date | exit 1, "past its own 1d staleness bound" |
| `stale_after_days: 1` on an **aged** absence | exit 1, "the declared absence has expired" |
| `stale_after_days: 0` | exit 1, "must be a positive integer" |
| `stale_after_days: true` | exit 1, same |
| duplicate an `id` | exit 1, "must be unique" |
| delete `exercise` | exit 1, "missing required field" |
| append a bare string to the array | exit 1, "not an object" |
| **no mutation** | exit 0 |
| point it at a file that does not exist | exit 2 |

**The example is dated on purpose, so it will eventually fail.**
`controls.example.json` carries real dates — an exercise on 2026-08-19 with a
90-day bound, an absence starting 2026-09-21 with a 45-day one. Run it late
enough and it exits 1 on staleness. That is not rot in the example; it is the
instrument doing the only thing that makes it worth having, on the one file
where you can watch it happen without it being your problem. Move the dates when
you copy it.

**The trap, found while running it.** The first pass through that table reported
seventeen of eighteen firing, with the aged-absence row silently passing. The
rule was not broken. The *fixture* was: the example's absence started the same
day the table was run, so it was zero days old against a one-day bound, and the
mutation could not express the failure it was named for. Re-run against a
`never_exercised_since` of `2026-01-01` and the refusal fires at 263 days.

That is worth more than the table it sits under. A row that does not go red is
either a broken rule or a fixture that cannot construct the failure — **and they
look identical from the outside.** The first reading is the interesting one, so
check the second before you file a bug against yourself.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works on one machine with no server; what a file
cannot do is attest who exercised a control — the name beside a date is
self-declared, not observed. musterd.io.*
