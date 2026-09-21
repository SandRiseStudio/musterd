---
name: capture-rough-explore-once
description: How to take a half-formed idea from somebody and not ruin it — capture the raw text verbatim with deterministic cleanup only, then one explorer at a time asking one decision-blocking question that only the submitter may answer, ending in one exhaustive brief that becomes an ordinary unowned work item. Ships a checker that refuses a seed which arrived pre-judged. Use when building an intake path, or when good ideas keep arriving and dying.
---

# capture-rough-explore-once

Someone has an idea at the wrong moment — in a corridor, on a phone, halfway
through something else. The idea is rough, and roughness is not a defect: it is
what an idea looks like before anyone has spent time on it.

Most intake systems ruin it in the first ten seconds, politely.

## Capture does exactly two things

**Keep the body verbatim.** The raw text *is* the record. Everything else is
derived from it, and anything that cannot be re-derived is somebody's opinion.

**Derive the title deterministically.** First non-empty line, whitespace
collapsed, cut at a word boundary at 80 characters. No model, no cleverness, no
summarisation.

That is the whole of capture. And the determinism is the point: **same input,
same title, every time**, which is what makes the absence of judgement
*checkable* rather than promised.

## What capture must not do, and why

No reasoning. No auto-tagging. No stakes, priority or goal suggestion. No
duplicate detection.

Each of those was considered and cut deliberately, because:

> **A seed that arrives pre-judged is a work item someone has to *argue with*
> instead of edit.**

Tag it, rank it, summarise it or mark it a duplicate before the submitter has
finished having the thought, and you have attached an opinion nobody asked for
to somebody else's idea — and made the first response to it *disagreement*.

The duplicate-detection one is worth dwelling on, because it feels most
obviously useful. An automatic "similar to #412" is a claim that this idea is
that idea, made by something that read eighty characters. If it is right,
someone will notice in a moment. If it is wrong, it has pre-closed the idea
under a label that now looks considered.

**Add all of it later, as an edit, under a name.** Editing is cheap. Arguing
with an automated opinion is not.

## Then: explore once

- **One explorer at a time.** Parallel explorers produce two briefs somebody
  has to reconcile — which is exactly the work the brief was supposed to do.
- **Claimed explicitly.** No background allocator starts exploring things. An
  exploration nobody claimed is one nobody finishes.
- **Clearly underspecified seeds skip exploration entirely** and go straight to
  asking. They spend no exploration capacity being puzzled over.

### One question at a time, and only the submitter answers

The explorer may ask **one minimal, decision-blocking question**, in the open.
Not a list.

> A list of questions is a form, and a form is answered badly or not at all.

And **only the submitting member may answer it.** Others may read; they may not
supply an authoritative clarification. Someone else's helpful guess about what
you meant, recorded as the answer, replaces your intent with a guess that now
looks official — and the explorer will build on it.

An answer unblocks the next exploration claim. A later blocking ambiguity
repeats the cycle.

## Then: one brief, and two terminal ends

Exploration produces **one exhaustive final brief** — not progress chatter. The
sharpened problem framing, the context, the evidence, the viable approaches and
their trade-offs, the constraints and unknowns, a recommendation, and a proposed
title and framing.

Two ways it can end, and no third:

- **Viable** → it becomes an **ordinary, unowned work item** from the proposed
  title and framing, carrying its provenance. No new gate, no special state, no
  required meeting. It is now the same kind of thing as everything else on the
  board, which is the point.
- **Not actionable** → the seed completes with the conclusion attached, and
  opens nothing.

**The seed body stays unchanged throughout.** Whatever the exploration decides,
the original text is still there to be read by someone who thinks the
exploration got it wrong.

## The checker

```sh
./seed.py title <body.txt>       # the deterministic title, and only that
./seed.py check <seed.json>...   # refuse a seed that arrived pre-judged
```

Python 3.8+, stdlib only. It refuses a missing body or provenance, **any
judgement field at capture time**, a title that is not the deterministic
derivation of the body, an invalid lifecycle state, two explorers at once,
`exploring` with nobody named, a clarification answered by someone other than
the submitter, and more than one unanswered question at a time.

The title check is the sharp one:

```
x `title` is not the deterministic derivation of `body`.
      got  'Improve roster reachability'
      want 'what if the roster could show who is actually reachable right now rather than'
```

**A title somebody chose is the first interpretation, and it is the one that
sticks** — it is what everyone reads on the board afterwards, usually without
opening the body.

## The falsifier

Fourteen refusals and five must-*not*-fire cases exercised on 2026-09-21:

| Seed | Expected |
| --- | --- |
| no `body` | exit 1, "the raw text IS the seed" |
| missing `captured_at` / `source` / `submitter` | exit 1, "provenance is not interpretation" |
| `tags`, `stakes`, `duplicate_of`, `summary` at capture | exit 1, naming the field |
| a hand-written `title` | exit 1, showing got vs want |
| a lifecycle state outside the six | exit 1 |
| two explorers at once | exit 1, "two briefs to reconcile" |
| `exploring` with no explorer named | exit 1 |
| a clarification answered by a non-submitter | exit 1, "replaces their intent with a guess" |
| two unanswered questions at once | exit 1, "a form is answered badly or not at all" |
| the clean example | exit 0 |
| a clarification answered **by** the submitter | exit 0 |
| one explorer, `exploring` | exit 0 |
| no `title` field at all | exit 0 — deriving it later is fine |
| an unreadable file | exit 2 |

Run `title` twice on the same file before trusting any of it. If it returns two
different strings you do not have a capture rule, you have a summariser.

## Two things a file cannot do

- **There is no always-on capture channel here.** The whole value of capture is
  that it works when your machine is shut and you are somewhere else. A script
  in a repo cannot receive a message at midnight; that needs something hosted.
- **Nothing enforces one explorer at a time.** The checker sees a seed that
  *recorded* two explorers. It cannot stop the second one from starting.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works on one machine with no server; what a file
cannot do is receive an idea while your laptop is shut, or stop a second
explorer from claiming a seat someone already holds. musterd.io.*
