---
name: measure-agents-honestly
description: How to measure whether a multi-agent setup actually helps — a pre-registered manifest whose ruler cannot bend to fit the result, wasted work reconstructed from git alone, results that diagnose rather than rank, and the denominator that decides whether your headline is a finding or a sales pitch. Use before running any agent comparison, when writing up one, or when someone quotes a multiplier at you.
---

# measure-agents-honestly

Measuring agents is unusually easy to get wrong, because you are the one who
chose the tasks, the arms, the scoring and the stopping point — and you already
know which answer you want.

Nothing here is about statistics. It is four habits that make it expensive to
fool yourself, and one sentence about denominators that matters more than the
other three combined.

## 1. Pre-register the manifest — a frozen ruler must not bend

Before the run: pin the question, the model, the harness *and its version*, the
starting commit, every arm including the controls, the scoring rules and their
version, what the headline is, what must not get worse, and when you stop.

**Changing the scoring rules after a run has started is not a correction. It is
a new ruler.** If you change them, that is a new versioned predicate set,
disclosed *before* the runs it scores — never applied retroactively to runs
already in hand.

Two pins earn special mention because they are the ones people leave out:

- **The stop rule.** Decided before the run, or "when it looked done" becomes
  "when it looked good".
- **The guardrail** — what must *not* get worse for the headline to count. A
  headline with no guardrail can always be bought with something you did not
  measure. Fewer duplicated lines is not a win if correctness fell.

```sh
./manifest.py check  manifest.json    # every pin present and well formed
./manifest.py freeze manifest.json    # record its hash, before the run
./manifest.py verify manifest.json    # refuse if it changed since
```

`freeze` refuses to freeze a manifest that does not pass `check`, so there is no
frozen-but-incomplete state.

**Why a hash.** "Pre-registered" is a claim about the past, and prose cannot
carry it — a manifest edited mid-run looks exactly like one written carefully up
front. **And be honest about the limit:** the freeze file is written by the same
person, on the same machine, and can be regenerated at any time. It defeats
drift and forgetfulness, not a determined author. Publish the hash somewhere you
do not control — the pre-registration itself, an issue, a commit someone else
reviews — and it starts meaning something to a reader.

`verify` distinguishes **never frozen** from **changed**, and says so. They are
different facts and only one is an accusation.

## 2. Reconstruct wasted work from git alone

You want a number nobody has to adjudicate. Git has one, if you define it before
you look.

Classify every line authored inside the run window exactly once, in precedence
order:

| | Class | What it catches |
| --- | --- | --- |
| **W3** | duplicated | one actor re-produces work another already did — identical patch-ids, or overlapping hunks past a threshold you fix in advance. The **later** copy is the waste. |
| **W1** | abandoned | not reachable from the delivered state, **and** with no patch-equivalent commit in delivered history |
| **W2** | clobbered | X's lines deleted or overwritten by a *different* actor before the run ends |
| **W4** | conflict churn | where the real merge differs from a clean auto-merge — hand-resolved conflict content |

Duplication outranks abandonment deliberately: a branch abandoned *because* it
duplicated another is duplicate work, not generic churn.

### The two exclusions that cost the most to learn

**A surviving reimplementation is not waste.** If work was rebased, re-landed,
or rewritten and the result shipped, it is not waste — it is how software gets
made. The patch-equivalence test is what enforces this. Getting it wrong once
would have inflated one of our measurements by ~950 lines, in the direction we
wanted.

**Self-rework is never waste.** X revising X's own lines is iteration, and
counting it means measuring how much someone thought.

Also exclude, uniformly across arms: generated artifacts and lockfiles,
whitespace, and everything present at the starting commit.

And **count the human touches too**, with a taxonomy fixed in advance —
dispatch, unstick, answer, tie-break, conflict-resolution, correction. The
coordinated arm must pay full fare: every message a human sends *through* the
coordination layer is an intervention, scored identically. An arm that looks
cheap because its human effort was invisible is not a result.

## 3. Diagnose, do not rank

- **Never rank the members.** The setup is the subject, not the participants.
- **Every rate carries its denominator and its collection channel**, in the
  same sentence. A rate whose denominator you have to go and find will be quoted
  without it.
- **One headline, its supporting numbers, and a guardrail — never a single
  collapsed score.** A composite score is a ranking with the reasoning removed,
  and the first thing anyone does with it is rank.
- **Report the per-class breakdown**, not just the total. "37% wasted" and "37%
  wasted, almost all of it one duplicated subsystem" prescribe different work.

## 4. The denominator decides whether you have a finding or a pitch

This is the one to get right, and it is the one that costs you your best number.

Our own measurements, to make it concrete. One agent alone: **0% wasted work,
all tickets accepted, ~24k output tokens.** Three coordinated agents: low waste,
same acceptance — and **≈7.7× the output tokens**, with a slower wall clock at
that scale.

So the honest sentence is:

> **The comparison is coordinated-N against *uncoordinated-N*, never against
> solo.** Solo wins on cost and wall-clock. Coordination is what you buy when
> you have already decided to run more than one agent; it is not a reason to.

Anyone reporting a multiplier against a solo baseline is answering "is
coordination good?" with a measurement of "are three agents more expensive than
one?" — and the answer to that was never in doubt.

Two more denominator traps, both ours:

- **Never invert a recall figure into a volume estimate.** One of our
  instruments catches ~68% of a hand-built, *unweighted* corpus. That is not
  "68% of what happens in the wild", and the corpus cannot support the second
  claim.
- **The pattern usually beats the number.** The same measurement's ten misses
  turned out to be four structural groups — all versions of *an agent writes a
  program, then runs it*. That the blindness was **concentrated on a
  most-travelled path** was worth more than the percentage, and no amount of
  precision on 68% would have produced it.

## 5. Run the zero-spend retro first

Before authorising an expensive run, ask what the logs you already have can
answer — and **write down, in advance, what the free audit would have to show
for the paid run to still be necessary.**

Decided afterwards, that rule is unfalsifiable: whatever the audit shows, the
run can still be justified.

One of our zero-spend audits produced a usable error bar on a 40-item corpus
with ground truth *taken* (by hashing the resulting file tree) rather than
asserted, for nothing.

**And record the pre-registration defects it exposes.** The same audit could not
run one of its pre-registered arms, because the method it had pre-registered —
spawn a sub-worker that writes files — is a thing our own rules forbid. That is
a defect in the pre-registration, and it is written up as one rather than
quietly dropped. A pre-registration you cannot execute is a finding about the
pre-registration.

## The numbers on this page are dated, and one of ours is gated

Our best headline is a large multiplier for coordinated over uncoordinated
agents at equal correctness. It was measured on a build now roughly a thousand
commits old.

**We do not put it in outbound material.** It is gated until a re-run, because a
number good enough to quote is a number worth re-measuring, and "it was true in
July" is not a claim about today's software.

That is the posture this skill is really teaching. **The number a reader gets
should be their own** — the coordinated arm is your setup, not ours, and a
multiplier from somebody else's repository on somebody else's build is
decoration. What transfers is the manifest, the predicates, and the denominator
rule.

## The falsifier

Sixteen refusals and six must-*not*-fire cases exercised on 2026-09-21 against
the shipped script:

| Mutation | Expected |
| --- | --- |
| drop any one of the ten scalar pins | exit 1, naming it and why it is pinned |
| `arms` with a single entry | exit 1, "a single arm is not a comparison" |
| `arms` not a list | exit 1, same |
| `declared_on: "21/09/2026"` | exit 1, "must be YYYY-MM-DD" |
| `kickoff_sha: "main"` | exit 1, "a branch name is not a pin — it moves" |
| a one-word `denominator` | exit 1, "in words a stranger can check" |
| `guardrail: "none"` | exit 1, "if truly none, say why" |
| no mutation | exit 0 |
| `freeze` on a manifest failing `check` | exit 1 — no frozen-but-incomplete state |
| `verify` with no freeze file | exit 1, **"never frozen"** — not "changed" |
| edit after freezing | exit 1, **"CHANGED"**, with both hashes |
| reorder the keys and reindent | exit 0 — the hash is canonical, not textual |
| unreadable file | exit 2 |

The reorder row is the one worth keeping: a hash over raw file bytes would
refuse a reformat, and a check that fails when you tidy a file teaches people to
stop tidying it.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works on one machine with no server; what a file
cannot do is be the coordinated arm — that is the thing under test, and the
number you get should be your own. musterd.io.*
