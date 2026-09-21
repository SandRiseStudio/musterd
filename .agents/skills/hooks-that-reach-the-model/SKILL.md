---
name: hooks-that-reach-the-model
description: A hook that runs and a hook whose output the model actually sees are different facts, and most harnesses only tell you the first. The per-harness reachability table with a falsifier per row, the house style that keeps a hook from breaking someone's turn, and a canary that measures your own harness instead of trusting a table. Use when wiring any agent-harness hook, when an injected reminder is being ignored, or when a hook "works" and nothing changes.
---

# hooks-that-reach-the-model

Agent harnesses let you run a command on lifecycle events — session start, tool
boundaries, idle. It is the obvious way to inject context an agent keeps
forgetting.

There are **two questions here that look like one**:

1. **Did the hook run?** The harness executed your command.
2. **Did its output reach the model?** The text entered the model's context.

Harnesses answer question 1 loudly — exit codes, hook logs, a line in the
transcript. Most answer question 2 not at all. And the gap between them is
silent: a hook that runs perfectly into a debug channel looks exactly like a
hook that works.

We ran one for weeks before measuring: **67 of 67 injected lines went to the
debug log and none reached the model.** Every signal available said the hook was
fine. It was: it ran, every time, and did nothing.

## What "reaching" actually requires

Three things must all hold, and each fails independently:

- **The event fires.** Some harnesses do not dispatch the event you configured.
- **The file is read.** Some harnesses resolve the config path somewhere other
  than where you put it (see the worktree trap below).
- **The output is routed to the model.** This is the one nobody checks, and the
  one that varies *per event within a single harness*.

That last point is the whole reason for the table: on more than one harness,
**one event's output reaches the model and its neighbour's does not.**

## The measured table

**Read this as a worked example, not as current truth about your harness.**
These are dated observations made on specific versions by people who are not
you, and hook surfaces move fast. The table's job is to show you the *shape* of
the answer and what a row must carry. Run the canary below to get your own.

| Harness | Event | Reaches the model? | Falsifier |
| --- | --- | --- | --- |
| Claude Code | `SessionStart` stdout | **yes** | remove the hook and see the orientation vanish from the next session's context |
| Claude Code | `UserPromptSubmit` stdout | **yes** | a sentinel emitted here appears in the transcript under a content key |
| Claude Code | `PostToolUse` **bare stdout** | **no** (2026-09-05) | 67/67 lines in one transcript went to the debug log; emit a sentinel on bare stdout and find it under a hook-output key |
| Claude Code | `PostToolUse` via `hookSpecificOutput.additionalContext` | **yes** | the same sentinel in the same event, wrapped in that JSON, lands under a content key |
| Claude Code | `PreToolUse` deny JSON | **yes** — it blocks and the reason is shown | deny a tool and read the refusal text back |
| Claude Code | `Notification` stdout | **no** — it reaches the *human's terminal* | that is the point of it; do not use it to talk to the model |
| Cursor | `sessionStart`, `postToolUse`, `preToolUse`, `sessionEnd` | yes, with its own JSON keys | see the dual-format rule below |
| Cursor CLI | `afterShellExecution` / `afterMCPExecution` | yes | added because older CLI builds did not dispatch the standard set at all (2026-08-13) |
| Codex | `SessionStart` / `SessionEnd` / `PostToolUse` only | — | there is **no** gate, interrupt or notification event to configure |
| Grok CLI | `PostToolUse` stdout **and** `additionalContext` | **no** (2026-09-03, v1.0.13) | a `PostToolUse` sentinel in either shape is absent from that session's history file |
| Grok CLI | `PreToolUse` `additionalContext` | **yes** | the same sentinel, same session, one event earlier, is present |
| Grok CLI | `UserPromptSubmit` `additionalContext` | **no** — discarded | so no repeating per-turn nudge is possible there |
| OpenCode | — | no hook events in this shape at all | it exposes a *plugin* API instead; a different seam with different rules |

Two rows deserve pulling out, because they cost real time to find.

### The worktree trap: the file you edited is not the file that is read

One harness resolves its project hook config against the **git common
directory's** root, not the directory it was invoked in. So in a git worktree, a
hook file placed at that worktree's own path is **silently never read** — no
error, no warning, just an event that never fires.

Measured 2026-09-02: a canary hook at the worktree's config path never fired;
the identical file at the main checkout's path fired every time; and the working
directory handed to the hook was still the worktree's. So a shared file at the
common-dir root is both necessary *and* sufficient — per-directory identity
survives through the working directory the hook is given.

> **Falsifier:** put a canary hook in a worktree's config path, do something
> that should fire it, and check whether it ran. If it did, this does not apply
> to your version.

### Neighbouring events disagree, within one harness

On Grok CLI 1.0.13, `PostToolUse` output does not reach the model in *either*
injection shape — while `PreToolUse` `additionalContext`, one event earlier in
the same loop, does. A design that assumed the first works, by analogy with
another harness, had to move to the second.

**Never infer one event's behaviour from another's, or one harness's from
another's.** That inference is what the canary exists to replace.

## The house style

Six rules. The first is not negotiable.

### 1. Fail open, always

A hook runs on someone's turn. If it errors, exits non-zero, or hangs, you have
broken the thing you were trying to help.

```sh
command -v mytool >/dev/null 2>&1 && mytool nudge 2>/dev/null || true
```

`|| true` at the end, stderr discarded, and a `command -v` guard so a machine
without the tool is silent rather than noisy. **A hook that cannot run should
produce nothing, not an error.**

### 2. Change to the project directory first

Hooks do not reliably inherit the working directory you expect. Start with it,
and make the failure harmless:

```sh
cd "${PROJECT_DIR:-.}" 2>/dev/null; ...
```

### 3. Carry a versioned marker comment

An installer has to find its own lines later — to replace them, to remove them,
or to notice they are stale. A trailing comment does that and costs nothing:

```sh
... || true # mytool-posttooluse-hook e21
```

The `e21` is a content epoch. It buys the thing a marker alone cannot: **an
installed hook can be compared to the version that should be there.** Marker
present but epoch behind means stale, which is a different repair from missing
— and a hook whose *text* changed while its name did not is exactly the drift a
presence check cannot see.

> Watch the failure mode: if every copy is written from one shared source, they
> will all be stale *together*, and a check that compares them to each other has
> nothing to compare. Compare to the epoch, not to a sibling.

### 4. One script, both JSON dialects

Harnesses disagree on the key names for the same decision. Emit both; each
ignores what it does not know:

```json
{
  "permission": "deny",
  "user_message": "<reason>",
  "agent_message": "<reason>",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "<reason>"
  }
}
```

The same trick for a non-blocking note: `additional_context` and
`hookSpecificOutput.additionalContext` side by side. One script then serves two
harnesses with no branching and no detection.

### 5. Self-gate, so unrelated projects stay silent

Install globally, fire only where a marker file says this project opted in:

```sh
f="${PROJECT_DIR:-.}/AGENTS.md"; test -f "$f" && grep -q my-marker "$f" || exit 0
```

This is the only placement that covers a **fresh clone that was never set up
here** — the marker is committed, so the hook fires, discovers nothing is
configured, and can say so instead of silently doing nothing.

### 6. Keep it short and name the exact action

A noisy hook trains the model to skip it. One imperative line, naming the tool
to call — not a paragraph of context it will learn to scroll past.

## The canary

```sh
./canary.py emit  [--event NAME] [--state DIR]    # run this FROM the hook
./canary.py check [--state DIR] <transcript>...   # then run this
```

`emit` mints a unique sentinel, records on disk **that the hook ran**, and
prints the sentinel in every shape a harness might read — bare stdout, and JSON
under both `hookSpecificOutput.additionalContext` and `additional_context`.

`check` searches the transcripts you name and reports **where** it found the
sentinel, because a sentinel under a debug or hook-output key is the failure
this tool exists to catch, not a success.

| Exit | Verdict | Meaning |
| --- | --- | --- |
| 0 | `REACHED` | found under a key the harness feeds to the model |
| 1 | `DID NOT REACH` | ran, and is absent from a readable transcript — or sits under a known log key |
| 2 | `NEVER RAN` | no canary state at all: wrong file, wrong event name, or never dispatched |
| 3 | `CANNOT TELL` | no readable transcript — or found under a key this tool does not recognise |

### It refuses on positive evidence only

Exit 1 is the only verdict that accuses, so it is returned **only** on positive
evidence: the sentinel is genuinely absent from a transcript that could be read,
or it sits under a key known to be a log.

A sentinel under an **unrecognised** key is exit 3, never exit 1. An unfamiliar
key is a gap in this tool's vocabulary, not a fact about your harness. The fix
is to read the surrounding record yourself and add the key to `REACHING_KEYS` or
`LOGGING_KEYS`.

**That distinction is a bug this tool shipped with and lost.** The first version
returned "DID NOT REACH" for an unrecognised key, for plain text with no
structure, *and* for genuine absence — three causes, one reading, and the one
that accuses. It was found by running the check against a fixture with a made-up
key name and noticing the verdict was more confident than the evidence.

And one honest limit that stays: **a key name is evidence, not proof.** This
tool reads key names, and a harness could route a key called `content` straight
to a log. Read the surrounding record before you believe exit 0.

## Two things a file cannot do

- **Nothing is *delivered* into the pipe.** You can prove a channel is
  reachable. You cannot prove a real message arrives on it — that needs
  something on the other end with a reason to send one.
- **Nothing attests the hook ran** except the hook itself. The state file is
  written by the thing whose execution is in question, so a missing file means
  "did not run" *or* "ran and could not write", and this tool cannot separate
  them. It says `NEVER RAN` and names both.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works on one machine with no server; what a file
cannot do is deliver a real message into the channel you just proved reachable,
or attest to anyone else that your hook ran. musterd.io.*
