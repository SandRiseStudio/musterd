---
name: skill-home-and-provenance
description: Where a reviewed skill lives when more than one agent harness has to read it, and what you owe an upstream you adapted. Use when adding a skill to a repo, when the same guidance has started to exist in two places, or when vendoring skill material from someone else's repository.
---

# skill-home-and-provenance

A skill is a document several harnesses read. The moment a second harness
wants it, you have a choice: keep one body and point at it, or keep a copy per
harness. Copies are easier for a day and wrong forever after — they drift
silently, and nothing tells you which one the model actually read.

This skill is the shape that avoids that, plus what you owe an upstream whose
material you adapted.

## One canonical body

Put the skill at `.agents/skills/<name>/SKILL.md`.

`.agents/` is harness-neutral by construction — no vendor owns the directory,
so no vendor's tooling treats it as output and overwrites it. The body is repo
content: authored on a branch, reviewed in a PR, owned like any other document.

Everything else that reads the skill is a **bridge**: a stub in the harness's
own directory whose job is to say *read the canonical body*, not to repeat it.

```
.agents/skills/my-skill/
  SKILL.md          ← the only copy of the body
  PROVENANCE.md     ← only if material was adapted from elsewhere
  LICENSES/         ← only if material was adapted from elsewhere
```

## The one rule that keeps it honest

**Generated guidance is gitignored. Reviewed content is committed.**

If you have both — a pipeline that writes per-harness guidance *and* a
committed skill directory — this is the line that tells a reader which system
they are looking at, and therefore whether editing the file in front of them
will survive. Write it down where both live.

It has a corollary that surprises people: a **generated** bridge may legitimately
be a full copy, because it is regenerated from one source and never hand-edited.
A **committed** bridge must be a pointer, because nothing regenerates it. Someone
who opens a generated copy and concludes "bridges are copies here" will then
hand-write a second body and call it consistent. Say which system a directory
belongs to in the directory itself.

## Bridges, per harness

A bridge carries the frontmatter its harness needs so the skill is *findable*,
and a body of two or three lines pointing at the canonical path. Verify the
path your harness actually reads before writing a README sentence that claims
it — harness skill surfaces differ more than their docs suggest, and at least
one has none at all.

Measured against four harnesses (2026-09-21; falsifier: provision a seat and
list the files each harness reads):

| Harness | Where a project-level skill is read from |
| --- | --- |
| Claude Code | `.claude/skills/<name>/SKILL.md`, frontmatter `name` + `description` |
| Cursor | `.cursor/rules/<name>.mdc`, frontmatter `description` + `alwaysApply` |
| Grok | `.grok/skills/<name>/SKILL.md` |
| Codex | **no project-level skill or rule shell** — reach it from `AGENTS.md`, which Codex does read |

That last row is the one worth carrying. A plan that assumes every harness has
a skill directory will quietly ship a skill Codex never loads; the honest
version is a pointer in the file Codex already reads. Re-check this table before
trusting it — these surfaces move, and a stale row here is exactly the failure
the skill is about.

A bridge is provisioned per workspace, not committed, when it names a path
specific to one agent's checkout. Commit bridges only when every reader shares
the layout.

## What you owe an upstream

If the skill adapts someone else's work: **adapt, don't mirror.**

Rewrite for your repo's voice, charter and constraints. Do not take wholesale
file copies. Then record, in `PROVENANCE.md`:

- the upstream repo URL;
- the **exact commit SHA you reviewed** — not a branch name, which moves;
- the license;
- what you actually took, named specifically enough that a reader can check it.

Preserve license texts under `LICENSES/`. List sources you *consulted and did
not use* too — that is the difference between a record and a credit, and it
stops the next person re-reviewing the same repo to find out it had nothing.

Re-reviewing an upstream means updating its SHA in the same PR as any content
that changed because of it. A SHA that was true once and is now decoration is
worse than no SHA, because it reads as verified.

Falsifier for the whole file: `git -C <clone> rev-parse HEAD` against each
recorded SHA. If an upstream has moved, you have not been lied to — you have
been told to re-review before taking anything new.

## An imported skill is never a competing source of truth

Adapted material teaches *craft*. It must defer to whatever your repo makes
authoritative — its glossary, its spec, its brand or style document. If the
skill appears to contradict one of those, the skill has a bug; fix the skill.
Say this inside the skill body, near the top, so the reader meets it before
they meet the advice.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster,
and a record. musterd.io.*
