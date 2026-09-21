---
name: definition-of-done
description: What "done" has to mean before anyone says it — docs, traces and an eval as peers of tests, landed verified against the trunk rather than assumed, and a second party claiming it back. Use when finishing a task, defining a team's done, or when "done" and "merged" have started to drift apart.
---

# definition-of-done

Most teams have a definition of done that lists tests and nothing else, and a
"done" that means *I stopped working on it*. Those two gaps cause different
failures, and this skill closes both.

## Done is a conjunction, and docs are not optional members of it

A task is done only when **all** of these are true — not most:

1. It builds.
2. Strict typecheck, lint and format are clean.
3. Tests green, including the acceptance case for what you changed, and
   coverage meets whatever gate you set.
4. **Docs touched by the change are updated in the same commit.** Not the next
   one. A commit that changes behaviour and leaves its doc stale has shipped a
   lie with a true diff attached.
5. Any deviation from the documented way has a written decision.
6. Surfaces with a pinned appearance still match it (snapshots pass).
7. **For agent-facing changes: the traces it emits and an eval — or an explicit,
   reasoned `n/a` — are present and described in the same commit.** Peer to
   tests and docs, not a follow-up. "We'll add observability later" is how you
   get a system whose behaviour nobody can ever measure, because later never has
   a deadline.
8. It **landed**: squash-merged with the required gate green, never a direct
   push to the trunk.

Clauses 4 and 7 are the ones teams drop first, and they are the reason this list
is worth writing down at all. Tests were never the part people skipped.

The local run of 1–3 is a fast smoke test for speed. **CI is the authority** —
if they disagree, CI is right and your machine is interesting.

## Done is two claims, not one

The person who did the work claims it is done. That is one claim. It is not
enough, and the reason is not distrust — it is that the author is the one person
who cannot see what they assumed.

A second party claims it back: they judge the **landed outcome**, not the diff.
Did it do what the work was for; does it hold to the rules the team actually
keeps; does it work when exercised; does it feel right where anyone will see it.

Two properties matter more than the ceremony:

- **The acceptance is the verdict.** Not a comment that a close follows — the
  act of accepting is what finishes it. A separate "now close it" step is a step
  that gets skipped, and then nobody can tell finished work from abandoned work.
- **If nobody was asked, say so.** A self-close where no second party existed is
  legitimate, and it is a *different fact* from a reviewed close. Record which
  one happened. A team that cannot distinguish them has no idea how much of its
  work has ever been looked at.

## Landed is a measurement, not a feeling

"It's merged" is the single most common false claim in software, and it is
trivially checkable:

```sh
./landed.sh <sha> [remote] [branch]
```

It prints one of five tiers:

| Tier | Meaning | Exit |
| --- | --- | --- |
| `ancestor` | it landed — the sha is on the trunk | 0 |
| `not_ancestor` | it did **not** land, and the fetch worked, so we can say so | 1 |
| `unknown_object` | this repo has never heard of that sha | 2 |
| `fetch_failed` | could not reach the remote — unknown, and not guessed | 3 |
| `unattested` | no sha was given at all | 4 |

### The rule the tiers exist for: refuse on positive evidence only

A failed fetch and a genuinely unmerged commit are **different facts**. Collapse
them into "not merged" and an offline laptop becomes a false accusation; collapse
them the other way and an unmerged commit passes as shipped.

So `not_ancestor` — the only tier that accuses — is returned **only behind a
fetch that actually succeeded**. Without one it degrades to `fetch_failed`, which
says *I don't know* and lets the work proceed. Abstentions never block.

This is worth internalising beyond this script: any check that gates other
people's work needs a way to say "I could not tell", or it will eventually
punish someone for its own outage.

### Squash changes the sha

If your trunk squash-merges, the commit that lands is **not** the commit you
pushed. Verify the sha the merge produced, not the one on your branch — the
branch sha will honestly report `not_ancestor` forever.

## Worked example

```
$ ./landed.sh db53c3c7
ancestor

$ ./landed.sh <a commit still on my branch>
not_ancestor

$ ./landed.sh db53c3c7 nosuchremote main
fetch_failed
```

All five tiers were exercised against real repositories on 2026-09-21, including
`not_ancestor` in a scratch repo with a real remote. Falsifier: run the commands
above; a tier that cannot be produced is a tier that does not work.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Here, nobody records that you claimed done and no second party claims
it back — the two claims are an honour system in a file. musterd.io.*
