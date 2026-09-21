---
name: decision-records
description: The whole lifecycle of a numbered decision record — taking a number against everything in flight rather than everything that landed, publishing it before you write, freezing the Decision on accept so amendments are dated and append-only, and naming what would tell you it was wrong. Ships a checker that refuses a rewritten Decision, including across a rename. Use when adopting ADRs, when two records collided on a number, or when someone edits a decision that already shipped.
---

# decision-records

A decision record is a numbered, dated document saying what was chosen and why.
Teams adopt them, write ten, and then lose the two properties that made them
worth having.

**They collide on numbers**, because the obvious way to pick the next one reads
what has landed, and the number you need is claimed by work that has not landed
yet.

**They get quietly rewritten.** Someone learns the decision was wrong and
*improves* the record — and now the document says the team chose the thing it
actually chose second. The reasoning that produced the original is gone, along
with any way to learn from having been wrong.

Both have cheap structural fixes.

## The lifecycle

```
take a number  ->  publish it  ->  write the record  ->  accept  ->  amend, dated
   (against         (before        (decision, context,    (Decision    (append only,
 everything          you             consequences,         freezes)     in place)
  in flight)         write)          what would falsify it)
```

Five rules hang off that, and the first two are about the same ninety minutes.

## 1. Take the number against everything in flight, not everything that landed

Read three places and take **one past the highest any of them claims**: your
working tree, the trunk, and the files changed by every open pull request.

Reading the trunk alone is what produces collisions. We had two authors take the
same number on one afternoon — both used the tool, both reads were correct when
made, and both produced the same number.

Two properties are deliberate, and both are refusals:

**Gaps are never filled.** The next number is one past the highest claimed,
never the lowest unused. A gap usually means a number was referenced somewhere
before being abandoned or renumbered, and reusing it silently repoints an old
reference at a new decision — a worse failure than a wasted integer, and much
harder to see.

**It reports; it does not reserve.** No registry file, no lock. A reservation
scheme has to decide when an abandoned claim expires, and it becomes a second
source of truth able to disagree with git. **The set of in-flight numbers
already exists — it is the open pull requests.** So look at it rather than
mirroring it.

## 2. Publish the number before you write the record

This is the rule people skip, and it is the one that actually closed our
collision.

The open-PR check above is only as good as what has been published. We assumed
the exposure window was the gap between pushing and opening a PR — short, and
closing automatically. Measuring the collision showed otherwise: the winning PR
was open for **three minutes** before it merged, at the very end of the work.

In practice a record is written, revised and gated on an unpushed branch for the
whole session. **The number is taken at minute zero and published at minute
ninety.** The window is not the push-to-PR gap; it is the entire authoring
session, during which the rung that would have caught the collision had nothing
to look at.

So: the moment you take a number, **push the branch as a draft pull request
whose title names it.** Body empty. Then write.

It is not reservation, and that is the point — it has no release problem. Close
the draft and the number is released and never reclaimed, exactly as the gap
rule requires. It does not *close* the window either: two people running the
tool in the same minute still collide. It shrinks a ninety-minute target to a
sixty-second one with machinery that already exists.

## 3. An accepted Decision is frozen — and only the Decision

Once a record is accepted, its `## Decision` section is a historical record of
what was chosen. **Two sanctioned moves, and no third:**

- **Annotating what happened next** → a dated note in Consequences, or a dated
  marker inside Decision: `_(Amended 2026-05-05: the way was renamed.)_`.
  Append-only. In-place amendment *is* the prescribed mechanism, not a
  workaround.
- **Reversing the decision** → a **new** record that supersedes this one.

Every other section — Context, Consequences, Observability — stays fully
editable, so typo fixes and follow-up notes need no ceremony.

**The date is not decoration.** It is what makes an amendment a record rather
than a note, so an undated marker is refused like any other new prose. That is
enforced below, and it is worth enforcing: an undated "Amended" is
indistinguishable from someone editing the decision and labelling it politely.

## 4. Name what would tell you this was wrong

A decision that affects behaviour names, in the record, how you would know:
what it emits, what you will measure, and against what baseline — or an
explicit, reasoned **`n/a`**.

The `n/a` matters as much as the measurement. An empty section reads as *nobody
got to it*; a reasoned `n/a` reads as *we thought about it and here is why
there is nothing to measure*, and a reader can disagree with the second.

## 5. A sentence that promises future work names its disposition

Every "we'll do this later" carries one machine-checkable line:

```
Follows-up: <work-item-id>
Follows-up: deferred — <the trigger that would reopen it> (<date>)
Follows-up: none — <why this needs no work> (<date>)
```

**Silence is the one shape refused.** A deferral with a named trigger is a fine
answer. A `none` with a reason is a fine answer. A promise with nothing after it
is how a record accumulates work nobody owns, and it reads identically to work
in progress.

## The deviation protocol

The rule that makes all of the above fire at the right moment. When you find an
error, a contradiction, a missing field, or a better approach:

1. **Do not silently deviate.**
2. Take a number, publish it, write the record.
3. Make the **smallest correct change**.
4. Update the affected docs **in the same commit**, referencing the record.

The trigger is worth memorising: **when you notice you are about to make a
judgment call, that is the moment the record is owed** — not after the work,
when you will remember the conclusion and not the alternatives.

## The script

```sh
./adr.py next  [--dir DIR] [--root DIR]              # the next free number
./adr.py check [--dir DIR] [--base REF] [--root DIR] # refuse a rewritten Decision
```

Python 3.8+, stdlib only. `git` required for `check`; `gh` optional for `next`.

### `next` degrades loudly

Without `gh`, unauthenticated, or offline, it still answers — with the highest
*landed* number — and says so on stderr:

```
! open pull requests were NOT consulted (no git remotes found).
  This number is one past the highest LANDED record. Someone may already
  hold it on an open branch. Check by hand, or publish yours immediately.
```

**Authoring must not require the network. A silent degrade would reinstate the
exact blind spot the open-PR rung removes**, so the degrade is never silent. It
prints the publish-now instruction on every run, including the good one.

### `check` reads a diff, and judges renames

For every record already accepted *before* this branch, `## Decision` must be
unchanged or changed only by adding dated markers.

Records that become accepted **in this very change** are exempt — they are being
authored, not amended — and a genuinely new accepted record always passes,
because writing a superseding record is the remedy this gate prescribes.
Refusing new files would break its own escape hatch.

## The rename that takes the whole rule off

A rule like this loops over a diff and compares each file's before and after. A
file that was **renamed** in the same diff has, depending on how git reports it,
*no before side to compare against* — so renaming a record and rewriting its
Decision in one commit is not judged at all. One `git mv` and the rule is gone,
silently, with the gate still green.

**Measured precisely, because the usual telling of this is slightly wrong.** On
git 2.51 rename detection is *on by default*, so a plain diff does report the
rename. Turn one config key off and it does not:

```
$ git diff --name-status BASE...HEAD -- decisions
R076  decisions/001-a-thing.md  decisions/001-r.md

$ git -c diff.renames=false diff --name-status BASE...HEAD -- decisions
D     decisions/001-a-thing.md
A     decisions/001-r.md

$ git -c diff.renames=false diff -M --name-status BASE...HEAD -- decisions
R076  decisions/001-a-thing.md  decisions/001-r.md
```

So the lesson is sharper than "git reports a rename as delete plus add". It is:
**rename detection is a configurable default, so a rule that relies on it works
on your machine and comes off silently in a repository that turned it off** — or
under an older git, or `--no-renames`, or a raw log. Pass `-M` explicitly. This
script does, and it still refuses under `diff.renames=false`.

## The falsifier

Both subcommands were exercised on 2026-09-21 against real git repositories —
the `check` cases in a scratch repo with real commits, `next` against a live
repository with open pull requests.

| Case | Expected |
| --- | --- |
| nothing changed | exit 0 |
| Consequences edited on an accepted record | exit 0 — only Decision is frozen |
| Decision rewritten on an accepted record | exit 1 |
| dated `_(Amended YYYY-MM-DD: …)_` appended | exit 0 |
| **undated** `_(Amended: …)_` appended | exit 1 |
| `git mv` **and** Decision rewritten | exit 1 — the evasion |
| `git mv` alone, Decision untouched | exit 0 |
| a genuinely new accepted record | exit 0 — the escape hatch |
| Decision rewritten on a *proposed* record | exit 0 — still being authored |
| a base ref that does not resolve | exit 2 — abstains, never a pass |
| `next` with no records | `1` |
| `next` where 005 exists and 003–004 do not | `6` — gaps are never filled |
| `next` where `gh` cannot answer | the landed number, **plus the warning** |
| `next` on a live repo | agreed with that repo's own reference tool: 433 |

### Two defects this shipped with, both found by running it

**A dated filename claimed a number in the 2000s.** `next` matched the
`NNN-slug` shape against every file in an open pull request, and
`2026-09-21-a-thing.md` has that shape. On a real repository it answered **2027**
instead of 433.

The first fix scoped the scan to the records directory — and **passed only by
coincidence**, because that repository's records directory happens to hold no
dated files. Putting one there brought 2027 straight back. Both guards are
needed: scope the directory, *and* refuse `YYYY-` followed by `MM-DD-` inside
it.

That is worth more than the bug. A fix verified only against the case that
produced the bug is a fix verified against one sample. The question that caught
it was **"what would have to be true for this to keep working?"** — and the
answer was an unstated assumption about somebody else's directory.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. This one travels whole: everything above is files, git, and one
script. musterd.io.*
