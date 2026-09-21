---
name: docs-that-catch-drift
description: Docs go stale for four specific reasons, and each has a structural fix — one doc one job, one fact one home, and "checker, not generator" — enforce the structure where it is mechanical and refuse to produce the prose where it is judgement. Ships a drift-checker for documented file trees with deliberately no --fix. Use when adopting docs conventions, when a doc has accumulated strikethroughs, or before writing a tool that generates documentation.
---

# docs-that-catch-drift

Note the name. Docs **can** drift — a checker only narrows *where*. Anything
promising documentation that cannot go stale is selling you something, and the
honest version is more useful anyway.

Four things make docs rot, and each has a structural fix rather than a
discipline fix.

## The four anti-patterns

**1. One doc doing several jobs at once.** Status, findings, roadmap and index
in one file. Its parts have different lifecycles, so it can never be rewritten —
only appended to. That is why such documents accumulate strikethroughs instead
of being replaced.

> **One doc, one job, one lifecycle.** Then a doc whose job is finished can be
> rewritten wholesale without anyone losing anything.

**2. Hand-narrating status that is derivable.** If it can be read off the
decision records, the tags, or the test count, writing it down by hand creates a
second copy that will disagree with the first.

**3. Re-narrating a decision somewhere a record already holds it.** Link, don't
restate.

**4. Two specs hand-synced.** A "live" one and a "draft" one, kept in step by
somebody remembering. There is one spec; unreleased work is an appendix inside
it.

Underneath all four is a single rule:

> **One fact has one home. Everything else points at it.**
>
> Duplication is what drifts. A pointer cannot disagree with its target.

And the commit-level version, which is the one that actually holds the line:
**docs and code never disagree at the end of a commit.** A behaviour change
updates its doc in the same commit — not the next one. A commit that changes
behaviour and leaves its doc stale has shipped a lie with a true diff attached.

## Checker, not generator

This is the part worth taking away even if you adopt nothing else.

When a document contains both mechanical structure and load-bearing judgement —
which is most useful documents — you have three options, and only one is good:

| | What happens |
| --- | --- |
| Check nothing | it drifts, silently, and you find out from a reader |
| **Generate it** | the judgement half gets written by a machine that has none |
| **Check the structure, refuse to write the prose** | a new file **fails** until a human says what it is |

The middle option is the tempting one and the damaging one. **A generated
description reads as documentation and says nothing**, which is strictly worse
than an empty section: an empty section invites a reader, and a filled one stops
them looking.

So: enforce the *set*, refuse to author the *sentence*.

```sh
./tree-check.py <doc-or-dir>... [--root DIR] [--ignore SUFFIX]...
```

A doc carries a block like this, and the checker verifies the file set against
the filesystem:

````markdown
## File tree `src/`

```
index.ts     — the entry point; wires the server and exits non-zero on a bad config
store.ts     — every read and write of the database goes through here
sub/util.ts  — string helpers shared by both of the above
```
````

It refuses a file that exists and is undocumented, an entry whose file is gone,
a tree pointing at a directory that does not exist, and **an entry with no
description** — because the description is the whole point and nothing will
write it for you.

**There is deliberately no `--fix`.**

## Four more instruments, and the rule each one taught

**A generated section anchored to something outside itself.** If you do
generate — a roadmap from a typed data module, say — then check the generated
output against a *signal the generator cannot see*, like git history. A
generator checked only against its own input is a tautology with a build step.

**Duplicate names, never descriptions.** Where two surfaces must both mention a
command, let the second duplicate the *name* only, and check that every name it
mentions still resolves. One-directional on purpose: a rename then breaks the
build, and a *semantic* change under a stable name does not — which is a real
gap, so cover the distinctions with a test each rather than pretending the name
check caught it.

**Writer and checker read the same list.** If a tool writes a scoped set of
files and another verifies that scope, they import the same exported list. Two
copies of a scope definition is the same doc-drift problem with a compile step.

**Measure a denylist's recall; do not assume it.** A hand-kept pattern list is a
floor, not an inventory. Label a corpus, measure what share the list actually
catches, and **print that number on every run** — so a green result says *no
match in a known shape*, never *no problem*. Ours reads well under half, and
saying so is what stops the gate being trusted for more than it does.

## Mentions are not uses

The trap that sinks a text gate, and it has a sharp edge.

**A document that defines a rule must write the rule down in order to forbid
it.** A style gate whose own rulebook enumerates the banned sentences will fail
its own rulebook — and the only ways out are to suppress the canonical list or
to paraphrase the bans until they stop being quotable. Both destroy the thing
being protected.

So strip mentions before matching: fenced code, comments, and — the case that
matters — **backticked and double-quoted spans**.

> **A gate that fails when you *document* it teaches you to document it less
> clearly.** That is a gate actively making your docs worse.

## Abstain rather than pass

`tree-check.py` counts code fences before it reads anything. An odd number means
it cannot tell code from prose in that file, so it **abstains at exit 2** rather
than reporting a pass.

This is not hypothetical. A sibling gate once met a document with a single stray
fence on line 1; its fence-pair stripping swallowed everything to the next
fence, including the paragraph the gate existed to police. **Every mutation
planted in that region reported green.**

> A gate that silently skips the most important surface it has is worse than no
> gate, because it is trusted.

Two more abstentions in the same spirit: a file that cannot be read, and **a run
that found no blocks at all**, which reports "nothing was checked — that is not
a pass" rather than a cheerful zero.

## The falsifier

Nine cases exercised on 2026-09-21 against a real directory tree:

| Case | Expected |
| --- | --- |
| doc and tree agree | exit 0 |
| a file exists and is undocumented | exit 1, naming it |
| a documented file no longer exists | exit 1, "remove the line, or restore the file" |
| an entry with no description | exit 1, "nothing will write it for you" |
| the tree names a directory that is not there | exit 1, "the stalest kind" |
| **odd number of code fences** | exit 2, **abstains** — not a pass, not a finding |
| a doc with no tree block at all | exit 2, "nothing was checked — that is not a pass" |
| a `*.test.ts` file, undocumented | exit 0 — ignored by default |
| the same file with `--ignore` overridden | exit 1 — the ignore list is yours |
| **a tree heading inside a fenced example** | exit 0 — a mention, not a use |
| a target that does not exist | exit 2 |

### The bug this shipped with, which is this page's own subject

The first version refused **its own SKILL.md**. The `## File tree` heading in
the example above sits inside a fenced block — it is documentation *of* the
format, not an instance of it — and the checker read it as a real tree, then
complained that `src/` was not a directory.

That is the mentions-are-not-uses trap, committed inside the file that warns
about it, by the person writing the warning. It is also the failure mode the
section above names exactly: **a gate that fails when you document it.** Had it
shipped, the first thing any adopter would have learned is to stop putting
examples in their docs.

The fix masks fenced regions before scanning for headings, and fences nest by
length — a ```` block may contain ``` blocks — so a fence closes only on one at
least as long as the one that opened it.

The cheap way to find this: **run the checker against its own documentation.**
Any text gate whose own docs must quote the thing it matches has this bug until
proven otherwise, and its own page is the shortest path to proving it.

One cosmetic defect from the same run: a declared path with a trailing slash
produced `src//new.ts` in the message. Harmless, fixed, and worth the line —
a message a reader has to squint at is the beginning of a gate people stop
reading.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. This one travels whole: it is files, a convention, and one script.
musterd.io.*
