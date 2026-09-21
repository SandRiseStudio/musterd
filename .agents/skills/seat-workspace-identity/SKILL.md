---
name: seat-workspace-identity
description: Give every agent its own workspace with its own git identity, so "who wrote this commit" is answerable without asking anyone — and know the exact line where that goes wrong, because repo-local git config is shared across work trees and the last one written owns everybody's commits. Ships a checker that tells a scoped identity from a shared one. Use when running more than one agent on a repo, when commits carry the wrong author, or when setting up agent workspaces.
---

# seat-workspace-identity

Run two agents on one repository and the first question you cannot answer is
*who wrote this?*

The fix is small: **one workspace per agent, each with its own git identity.**
Then `git log --format='%an <%ae>'` answers it natively, with no tool and no
lookup.

Getting there has exactly one trap, and it is worth knowing precisely rather
than approximately.

## The setup

```sh
# once, at the repository
git config extensions.worktreeConfig true

# then in each agent's work tree
git config --worktree user.name  "ada (agent)"
git config --worktree user.email "ada@yourteam.invalid"
```

`--worktree`, not `--local`. That is the whole thing.

Use a **synthetic domain** for the email. It is an identity label, not a
mailbox, and a synthetic one cannot collide with a real person's address. (Use a
domain reserved for the purpose, like `.invalid`, rather than one somebody could
register.)

## The trap, measured rather than repeated

The usual telling is "without the extension, the last workspace provisioned
silently renames every other workspace's commits". That is true about the
*outcome* and wrong about the *mechanism*, and the difference tells you which
line to look at.

**Measured on git 2.51:**

`git config --worktree` does **not** fail silently. It refuses, loudly:

```
fatal: --worktree cannot be used with multiple working trees unless the config
extension worktreeConfig is enabled. Please read "CONFIGURATION FILE"
```

So the dangerous line is not the one that fails. **It is the fallback after
it.** A provisioning script that does:

```sh
git config --worktree user.name "$SEAT" || git config user.name "$SEAT"   # ← this
```

converts a loud refusal into a **shared** write. `git config` with no scope flag
means `--local`, and repo-local config is shared by every work tree of that
repository.

Demonstrated end to end, in a scratch repo with two work trees:

```
$ cd a && git config --local user.name seat-a
$ cd ../b && git config user.name
seat-a
```

Work tree `b` never touched its configuration and now commits as `seat-a`.
**Nothing looks wrong on b's side** — which is why this is expensive: the
workspace that got renamed has no symptom to notice.

> The general shape: **a loud failure converted into a quiet success by an `||`
> is worse than the failure.** If a command refuses for a reason, a fallback
> that satisfies the caller anyway has thrown the reason away.

## What survives a squash merge

If your trunk squash-merges, per-workspace authorship is **lost on the trunk** —
the squash commit is authored by whichever account performed the merge.

So the identity has to ride in the commit *body*, as a trailer:

```
Co-authored-by: ada (agent) <ada@yourteam.invalid>
```

Default squash bodies concatenate the branch's commit messages, trailers
included. Keep the trailer when editing a squash body; it is the only part of
the attribution that survives.

## The checker

```sh
./identity.py check [--root DIR] [--expect-name N] [--expect-email E]
```

Exit 0 when the identity is this work tree's own, 1 when it is shared or
missing, 2 when git cannot answer. Python 3.8+, stdlib only.

It reports **which config file supplies the value**, because that is the whole
question:

```
work tree   /Users/nick/agents-dolly
linked      yes
extension   extensions.worktreeConfig = true
user.name   dolly (musterd seat)  [worktree]
user.email  dolly@revive.musterd  [worktree]

ok identity is this work tree's own (worktree-scoped)
```

A `[local]` or `[global]` scope in a linked work tree is the finding.

### It says when it cannot tell

In the **main** work tree there is no distinction to draw — a shared write and a
scoped one are the same file — so the check says exactly that instead of
reporting a pass it has not earned:

```
ok identity present. NOTE: this is the main work tree, so a shared write here is
   indistinguishable from a scoped one -- this check cannot tell them apart.
   Run it in a linked work tree to get a real answer.
```

## The falsifier

Exercised on 2026-09-21 against real git repositories, including two-work-tree
scratch repos and this one:

| Case | Expected |
| --- | --- |
| linked work tree, extension on, `--worktree` set | exit 0, scope `[worktree]` |
| identity written with `--local`, extension off | exit 1, "SHARED with every sibling" |
| **the sibling that set nothing** | exit 1 — reports the *other* workspace's name |
| extension off in a linked work tree | exit 1, and names the `||` fallback as the danger |
| no identity anywhere | exit 1, "one name for every agent" |
| `--expect-name` mismatch | exit 1, naming both values |
| the main work tree | exit 0 **with the cannot-tell note** |
| not a git work tree | exit 2 |

**One branch would not fire, and it was not the code.** "No identity anywhere"
never triggered, because a real machine almost always has a global `user.name`
— so the fixture could not construct the case it was named for. Proving the
branch reachable took suppressing global config explicitly:

```sh
env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null ./identity.py check
```

That is worth more than the row it verifies. On a developer machine, **"no
identity" is nearly unreachable and therefore nearly irrelevant** — the real
condition is a *global* identity quietly supplying one name for every agent,
which looks configured and is the thing you are trying to prevent.

## Two things this cannot do

- **The identity is a label, not an attested member.** Anyone can set any name.
  It answers "which workspace produced this" reliably and "who is accountable"
  only by convention.
- **Nothing stops two sessions in one workspace.** They will share the
  identity, the branch and the working tree, and produce commits that look like
  one agent's careful work.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works on one machine with no server; what a file
cannot do is make the name on a commit an attested member rather than a label,
or stop two sessions sharing one workspace. musterd.io.*
