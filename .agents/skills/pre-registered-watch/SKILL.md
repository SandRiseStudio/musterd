---
name: pre-registered-watch
description: A measurement that takes days is a pre-registered question with an owner and a death date — not a recurring sweep nobody reads. States the falsifier, the population, and what voids its own window before collection starts; cannot be renewed in place; and "nobody looked" is a recorded outcome. Use when a claim is about a rate or a recurrence, when installing a cron job or a dashboard, or when a decision rests on a snapshot of something that moves.
---

# pre-registered-watch

*One of three thin instruments from [dated-and-falsifiable](../dated-and-falsifiable/SKILL.md).
Each is a file convention plus a script of about two hundred lines; each works
alone, on one machine, with no server. They share one rule: **a record must be
able to fail.** If the check passes just as happily when the claim is wrong, it
is a ritual, not an instrument.*

**Some questions cannot be answered at a moment.** *Is this flaky? Did the fix
hold? Does that guard still catch anything?* Each is a claim about a quantity
that varies over time, and a single observation of a time-varying quantity is a
claim about the conditions it ran under — not a general statement.

Most teams have exactly one primitive for that: install a recurring sweep, and
hope someone reads it.

## Nobody reads it

Measured on our own instrument, a sweep running every five minutes:

| | |
| --- | --- |
| sweeps | 5,682 |
| window | 24.8 days |
| size | 49.5 MB |
| observations | 323,682 |
| times read | **0** |

The task asking someone to *decide whether the instrument earns its keep* sat
open and unowned for 25 days. Two distinct failures live in that series, and the
second is the one people do not expect.

**One — the pre-registered target was breached, loudly, and nobody looked.** The
design pre-registered a particular event at target **zero** and called any
instance a finding requiring inspection. It was **109**. And the instrument was
not silent about it: it set a non-zero exit code, wrote 214 alarm lines to its
log, raised a report entry until it cleared, and fired an OS notification on
repeats. The escalation path fired for 25 days and not one case was inspected.

> **An instrument that escalates into a channel with no owner is not
> observability. It is an alarm wired to a bell in an empty room.**

**Two — the rates in that series cannot be read at all.** The number of distinct
things sampled swung 23 → 196 → 9 inside the window. Any percentage over it
spans three populations and means nothing. Twenty-five days and 49 MB of
ambiguity, accumulated in silence.

## A watch

One file, stating — **before collection starts** — the question, the falsifier
that settles it, the population sampled, the conditions that disqualify its own
window, where samples accumulate, who is accountable, and the date by which it
must resolve.

```yaml
---
question:   Does the new backoff let a retry storm reach the payments API again?
claim_ref:  SKILL.md
falsifier:  "Any 60-second window with more than 3 retries to /charge from one client id. Target ZERO. A count, not a rate: the client population is expected to grow inside this window, so any percentage over it would span two populations and mean nothing."
population: the 41 client ids present in the registry on 2026-09-21. A client added or removed inside the window voids this watch rather than silently changing the denominator.
void_if:
  - the set of client ids changes from the 41 present at opening
  - the backoff constants in src/retry.ts change
  - the series file is truncated or rotated within the window
series:     ~/telemetry/charge-retries.jsonl
cadence:    1m
opened:     2026-09-21
opened_by:  dolly
revisit_by: 2026-10-12
status:     open
---
```

(`claim_ref` points at this skill only so the shipped example resolves out of
the box. In real use it is the decision, record or page the resolution posts
back to.)

It ends `resolved` (a verdict) or `void` (the window was disqualified, or nobody
looked). Both are terminal. Neither is silence.

## The four rules that carry the weight

### 1. The decider opens the watch, in the same diff

Never a patrol, never a backlog-grooming pass. When a decision rests on a
snapshot of something that moves, the person writing the decision opens the
watch **riding the act they are already performing.** A watch somebody has to
remember to open later is a watch that does not exist.

### 2. A watch cannot be renewed in place

`revisit_by` is immutable once merged. Continuing a question means a **new file,
a new question, a new diff someone reviews.**

> **Renewal must cost a decision, because free renewal is the disease.** The
> sweep above renewed itself 5,682 times, for nothing, because renewing was the
> default and stopping was the action.

### 3. `void` is an honest outcome, not a failure

A watch that expires unread resolves:

```yaml
status:     void
resolution: "unattended -- revisit_by passed with nobody reading the series. No verdict."
```

That records **that we failed to look**, which is a real datum and precisely
what an unread sweep hides. A team that cannot count its own unattended
measurements has no idea how much of its instrumentation is theatre.

### 4. Prefer a target-zero count over a rate

A rate needs a stable denominator; a count with target zero does not.

Our sweep carried both over identical data and a population that swung
23 → 196 → 9. The count stayed readable and produced a finding. **Every rate
became uninterpretable.** This choice costs nothing at authoring time and
**cannot be retrofitted after collection** — which is exactly why it is a
pre-registration rule and not analysis guidance.

## The gate

```sh
./watches.py [watches_dir] [--base <git-ref>] [--root <repo-root>]
```

Exit 0 when every watch is well formed and none has outlived its date, 1 when
one has, 2 when the directory cannot be read. Python 3.8+, standard library
only — the frontmatter subset is scalars and block lists, parsed in the script
rather than pulling in a YAML engine.

| Rule | Scope | What it refuses |
| --- | --- | --- |
| schema | tree | A missing field; a `void_if` with no conditions; a status outside the enum; a terminal watch with no verdict; a verdict on an open one; unreal or backwards dates; a `claim_ref` pointing nowhere. |
| **A1** no watch outlives its date | tree | An `open` watch past its own `revisit_by`. |
| **A2** `revisit_by` never moves | diff | A renewal in place. Needs `--base`. |

**`void_if` needs at least one condition.** A watch with no way to be void is
claiming its population cannot change — which is the assumption that made the
49 MB series unreadable.

**`claim_ref` must exist.** It is the post-back target: a resolution has to land
somewhere a reader already goes, or you have written rule 11 of the parent
skill — a correction that is recorded but not routed.

### A1 can break your build on a date rollover with no code change

Inherited deliberately from the sibling instrument
[controls-in-force](../controls-in-force/SKILL.md), and for the same reason: a
liveness check that cannot fail on its own is the disease. The pressure valve is
one honest line — resolve it, or void it as unattended. Both leave a record.

### The immutability check abstains rather than passing

`--base` is optional, and when it is absent the run says so:

```
ok watches: 1 total -- 1 open, 0 resolved, 0 void; none past its revisit_by
  ! immutability NOT checked -- pass --base <ref> to enforce it
```

When `--base` is given but git cannot answer it — a ref that does not resolve, a
shallow clone, no git at all — the run prints `immutability UNKNOWN ... Not a
pass` and still exits 0. **A check that reports "clean" from its own outage is
the exact failure this family is about**, so it reports the outage instead.

## This is not licence for background extraction

A watch is **finite, question-scoped, and dies at its resolution.** Rules 2 and
3 exist to make that structural rather than cultural. If you find yourself
opening a successor every time one expires, the question is answered and you are
running a sweep again — under a nicer name.

## The falsifier, and the trap that turned up three times

**Break each rule and watch it fire.** Copy `watches.example/`, mutate one
field, run the script on the copy. Thirteen refusals and four must-*not*-fire
cases were exercised this way on 2026-09-21, including the git rules in a
scratch repository with real commits:

| Mutation | Expected |
| --- | --- |
| delete `question` / `falsifier` | exit 1, "missing required field" |
| empty the `void_if` list | exit 1, "needs at least one condition" |
| `status: abandoned` | exit 1, "must be one of open \| resolved \| void" |
| `status: resolved`, no `resolution` | exit 1, "a terminal watch with no verdict" |
| add `resolution` to an open watch | exit 1, "move the status, or drop the verdict" |
| `revisit_by: 2026-02-31` | exit 1, "must be a real ISO date" |
| `opened: 21/09/2026` | exit 1, same |
| `revisit_by` before `opened` | exit 1, "must be after `opened`" |
| `claim_ref` pointing nowhere | exit 1, "which does not exist" |
| an **aged** open watch | exit 1, "open past its `revisit_by`" |
| a file with no frontmatter | exit 1, "a watch is its pre-registration" |
| `revisit_by` moved, with `--base` | exit 1, "cannot be renewed in place" |
| an aged **void** watch | exit 0 — terminal watches do not age |
| a **new** watch file, with `--base` | exit 0 — nothing to be immutable against |
| `--base` that does not resolve | exit 0, "immutability UNKNOWN ... Not a pass" |
| no mutation | exit 0 |
| a directory that is not there | exit 2 |

**Three of those rows did not fire on the first run, and none of them was a bug
in the gate.** Each was a fixture that could not construct the failure it was
named for:

- The `void_if` mutation used a regex that ate the closing `---`, so the file
  had no frontmatter at all and was refused one rule earlier. The right refusal,
  for the wrong reason, which reads identically from the outside.
- Both aged-watch rows set `revisit_by` into the past while leaving `opened` at
  today — so the **schema** rule fired first (`revisit_by must be after
  opened`) and A1 was never reached. One of them was even a must-not-fire case,
  which duly failed and looked like a real defect in A1.

This is the third time in three increments of this skill that the first
falsifier run has been wrong about its own fixture rather than about the code.
That rate is worth saying plainly: **when a rule does not fire, the fixture is a
likelier culprit than the rule, and the two are indistinguishable from the
outside.** Check the boring explanation before you file a bug against yourself.

The example's dates are real, so it will eventually go stale on purpose —
`revisit_by: 2026-10-12`. That is the instrument working, on the one file where
you can watch it happen without it being your problem.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works on one machine with no server; what a file
cannot do is route an expiring watch to the person who owns it — `opened_by` is
a name in frontmatter, not an address. musterd.io.*
