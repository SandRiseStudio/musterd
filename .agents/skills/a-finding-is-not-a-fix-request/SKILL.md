---
name: a-finding-is-not-a-fix-request
description: A review finding is REQUIRED only if the spec would have demanded it before anyone opened the diff — discovery adds information, not obligation. Four categories earn a block; everything else is a note that routes to the board under the finder's name, and complying with an out-of-scope REQUIRED is the failure mode, not the polite option. Use when reviewing a change, when a review has grown the work, or when a reviewer and an author are stuck.
---

# a-finding-is-not-a-fix-request

Review has a failure mode nobody names, because it looks like diligence.

A reviewer reads a change and sees something true: an edge case, a hardening
idea, a while-you're-in-there. They raise it. The author, wanting to get to
green, fixes it. Everyone behaves well and the change ships larger than it was
specified, carrying work **specified by nobody**, where the reviewer who
demanded it is the only person who ever judged it.

The fix is one classification rule.

## The rule

> **A finding is REQUIRED only if the spec would have demanded it before anyone
> opened the diff.**
>
> **Discovery adds information. It does not add obligation.**

Everything a reviewer finds is worth recording. The only question is *where it
routes* — into this change, or onto the board.

## The four categories that earn a block

| | What it is |
| --- | --- |
| **Honesty** | a claim in the change, its docs, or its provenance that is false |
| **Leaked secret** | a credential or token reaching a log, an error, a trace, a response |
| **Probe-measured regression** | **reproduced** against the reviewed head — with a test, a probe, or a driving scenario |
| **Named pin** | it violates something *already written* — an acceptance criterion, a decision clause, a doc/code disagreement, a rule the change's own text states, or a convention demonstrated in the tree |

Two of those have a sharp edge worth stating on its own.

**Reasoning about a failure is a note. Reproducing it is a REQUIRED.** "This
will break under concurrent writes" is a hypothesis, however well argued. The
same sentence with a scenario that makes it break is a different object.

**"Named" is load-bearing.** A named pin must quote or cite the pin *in the
finding itself*, with a file and a line, the way precedent is cited. Otherwise
the category is a claim about a claim.

> **A category claim with no probe and no pin is a note wearing a costume.**
> "This is a correctness issue" is a severity, not evidence for one.

## Everything else is noted, and a note has a floor

A hypothetical, an edge case the spec never named, a hardening idea — these are
notes. And a note is not a shrug:

- **It routes to the board as its own work item, under the finder's name.**
- Routing is not burying. It is the only route where the finding gets its own
  spec, its own stakes, and its own review — all of which an inline demand
  skips.

A note with nowhere to go is a finding you buried politely.

## The author's duty is the same paragraph

An author who receives a REQUIRED outside the four categories **declines it**
and does not expand the change.

**The decline has the same floor:** it names *which* of the four categories the
finding fails, and routes the finding to the board as a note under the finder's
name. A decline that names no category is the same costume from the other side.

Declining costs the author a record the way noting costs the reviewer one — so
the finding survives being wrong about its own severity.

> **Declining is not insubordination. Complying is the failure mode.**

An author who *wants* to take a noted finding may. The difference between
**taking** and **complying** is that taking is a decision recorded on the
change, with the measurement that justified it.

## The script

```sh
./finding.py check <finding.json>...   # validate
./finding.py template                  # a blank one
```

Python 3.8+, stdlib only. It refuses a REQUIRED with no probe and no pin, a
`named-pin` whose pin cites no file and line, a `probe-measured-regression` with
no probe, a note with no route or no finder, and a decline that names no
category.

**Leaked secrets are the one exception to the probe rule** — the finding *is*
the citation, and asking someone to reproduce one is asking them to leak it
again. It still has to say *where*.

### The bug this shipped with

The script's own example file contained this, and **passed**:

```json
{ "severity": "required",
  "category": "probe-measured-regression",
  "probe": "none — reasoned about, not reproduced" }
```

A presence check sees a non-empty string. The string says the evidence does not
exist. That is an assertion satisfied by its own negative case, inside the
validator whose entire job is refusing exactly this move — and it passed on the
first run, on the file shipped to demonstrate the rule.

Evidence fields are now rejected when their *contents* are a negation (`none`,
`n/a`, `tbd`, `—`) or too short to be followed, **and the two reasons are
reported separately**, because a message that misattributes its own reason
teaches the wrong repair.

The general form, which is the more useful half: **if a field is your evidence,
check what it says, not that it is there.** A required field is trivially
satisfied by a word meaning "nothing".

## What a file cannot do

**A noted finding has no board to land on under the finder's name.** The route
is the whole value of a note — it is what makes routing different from burying —
and a JSON file cannot carry it. `routed_to` is a promise the finder makes, not
a record anyone can check.

So if you adopt one half of this, adopt the routing half. The classification
without a place to route to is just a more articulate way of saying no.

## The falsifier

Sixteen refusals and five must-*not*-fire cases exercised on 2026-09-21:

| Finding | Expected |
| --- | --- |
| required, no probe and no pin | exit 1, "a NOTE wearing the word REQUIRED" |
| required, category outside the four | exit 1, naming the four |
| required with no category at all | exit 1, same |
| `probe-measured-regression` with no probe | exit 1, "the category IS the reproduction" |
| `named-pin` with no pin | exit 1, "'Named' is load-bearing" |
| `named-pin` whose pin cites no file:line | exit 1, "the way precedent is cited" |
| **`probe: "none — reasoned about"`** | exit 1, "says it has none" |
| **`pin: "n/a"`** | exit 1, same |
| **`probe: "it fails"`** | exit 1, "too short to be evidence" — a *different* message |
| note with no `routed_to` | exit 1, "a finding you buried politely" |
| note with no `finder` | exit 1, "routing is not burying; an unnamed note is" |
| severity outside the enum, missing summary | exit 1 |
| decline naming no category | exit 1, "the same costume from the other side" |
| decline with no route | exit 1 |
| a valid named-pin, note, leaked-secret, decline | exit 0 |
| an unreadable file | exit 2 |

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works on one machine with no server; what a file
cannot do is give a noted finding a board to land on under the finder's name.
musterd.io.*
