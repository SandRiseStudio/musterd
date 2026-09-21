---
name: two-consumers
description: Two questions to ask before a shared value gains another reader — what wrote this row, and who else reads it — plus the rule that absent is unknown, never zero. A documented discard is a precondition on every consumer, not an implementation note, and an omitted field conflates "observed nothing" with "predates the field". Ships a reader that refuses to print a rate over an incomplete population. Use before consuming a shared helper or column, or when a number looks complete and is not.
---

# two-consumers

Two failures, one root. Both happen when a value is read by more people than
the person who wrote it was thinking about.

## 1. A documented discard is a precondition on every consumer

A helper throws something away, and **says so** in its own documentation —
proudly, correctly, because the erasure is the point. "Normalises identity-
neutral differences." "Strips the passthrough wrapper."

That advertisement is the tell.

The first consumer wanted the erasure. The third consumer needed the thing that
was erased, read the documentation, saw the discard explained, and **treated the
explanation as a settlement.**

> **The documentation terminates the investigation.** A discard written down
> once reads as decided to everyone downstream who never re-derives whether it
> is right *for them*.

So the rule, and it is mechanical enough to grep for:

> **When a helper documents why it throws something away, that discard is a
> precondition on its consumers — not an implementation note.** The consumer
> list should be enumerable *before* the next consumer is added.

Find them: grep for helpers whose docs explain a discard, then count their
callers. The ratio is the risk.

### The version one rung worse

A test that **cites a decision record to justify an assertion** inherits that
record's *purpose* — and purpose does not transfer to every case the assertion
covers. One of ours asserted a defect as correct, citing an ADR by name as its
justification. The citation made it look considered. Nobody re-opened the ADR to
check whether it said that.

A citation is evidence that somebody thought about *something*. It is not
evidence they thought about *this*.

## 2. The check, both clauses together

Before adding a consumer to a shared value or transform:

> **What wrote this row, and who else reads it?**

Asking only the first gives you a value you understand and a change that breaks
somebody. Asking only the second gives you a list of people to notify about a
number whose meaning you have not established.

## 3. Absent is unknown — never zero, never a guess

A derived read over evidence has **at least three** outcomes: the fact holds,
the fact does not hold, and **the evidence supports neither**. The third is a
first-class value with its own name — not `null` overloaded, not a boolean's
falsy side, and not an omitted field the reader must interpret.

Four parts, each learned from getting one wrong:

**Name the abstention after its cause, not its shape.** `unknown` is fine when
there is one way to be uninformed. When there are several they are different
facts: *nobody was eligible* and *the required person was never available* are
both "no request was sent", and collapsing them rebuilds the defect one level
up.

**Record the distinction where it is KNOWN, not where it is needed.** A read
cannot recover a fact the system declined to write. **The fix for a guessing
read is almost always an earlier write.**

**Never backfill a verdict onto history.** Rows recorded before a distinction
existed keep their old label and are reported as **legacy, explicitly**.
Backfilling makes the record *look* complete while asserting things about the
past nobody observed — the original defect wearing the costume of a migration.

**Say what the abstention costs.** A read that abstains without saying *how
much* it abstained over invites the reader to treat the remainder as the whole.

### A worked example from our own repo, one day old

A field was written as **omitted** when a probe declared no value. But a row
missing that field already meant something else: *this writer predates the
field*. One reading, two causes, and no way to separate a pre-change row from a
post-change row whose probe genuinely had nothing.

The repair was one line: write `null` for a declared absence and keep omission
meaning *the writer is older than this field*. **Absent and declared-absent are
different facts, and they need different encodings.**

## The reader

```sh
./threestate.py <data.jsonl|data.json> --field NAME [--abstain VALUE]...
```

Exit 0 when the field is unambiguous, 1 when a rate over it would span two
populations, 2 when the input cannot be read.

It prints **absent first**, because that is the finding rather than a footnote:

```
field `attested` over 5 row(s)

  absent           1   <- the field is not there at all
  null             0
  abstained        1   <- recorded as 'we do not know'
  true             2
  false            1
```

And then it **refuses to print a rate**, naming both causes it cannot separate
and pointing the repair at the write rather than the read.

When every row carries the field it still will not hand you a bare rate — it
names the denominator, out loud, as the *decided* rows:

```
ok every row carries `a`; 1 abstained, so the denominator for any
   rate is the 2 decided row(s), and say so wherever you print it.
```

### Two more refusals worth having

**A partial read is not a result.** A malformed line makes it exit 2 rather than
report over the rows it managed to parse. Counting most of a file and printing a
number is how a truncated export becomes a finding.

**An empty file is not a zero.** "Nothing was counted, which is not a result."

## The falsifier

Nine cases exercised on 2026-09-21:

| Input | Expected |
| --- | --- |
| a row missing the field entirely | exit 1, naming both causes, no rate |
| every row present, none abstaining | exit 0, a rate over a complete population |
| every row present, some abstaining | exit 0, **the denominator named as the decided rows** |
| both `null` and an explicit abstention | exit 1, "name the second after its cause" |
| a JSON array instead of JSONL | exit 0 — both shapes read |
| one malformed line | exit 2, "refusing to report over a partial read" |
| an empty file | exit 2, "nothing was counted, which is not a result" |
| a missing file, or no `--field` | exit 2 |
| a custom `--abstain` value | exit 0, counted as an abstention |

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. This one travels whole: two questions, an encoding rule, and one
script. musterd.io.*
