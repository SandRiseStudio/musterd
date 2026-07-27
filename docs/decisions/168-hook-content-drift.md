# 168 — Hooks are content, not presence: stamp the shared hook and refuse the downgrade

- Status: proposed — 2026-07-27. Authored by izzo (lane `01KYJYRGXQJ10PWHKN2NNTNQX5`, opened by izzo
  2026-07-27 while rolling out the ADR 160 label-sweep trigger). Number **168** — next free above
  ADR 167 (stanley, #427) at branch time.
- Date: 2026-07-27
- Builds on: [ADR 165](165-worktree-family-mcp-entry.md) (the shared-slot shape this applies to the
  hook axis, and the precedent of flagging a stale shared slot _on presence_),
  [ADR 160](160-seat-session-labels.md) (the trigger whose rollout exposed this),
  [ADR 148](148-feature-epoch-roster-skew.md) (`FEATURE_EPOCH` — the capability-generation stamp this
  reuses), [ADR 060](060-verify-provisioning-not-assume.md) (the doctor / `init --check` drift
  surface), [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (the PostToolUse hook whose
  _absence_ the doctor already catches).

## Context

musterd installs six Claude Code hooks. Five are project-local (`.claude/settings.local.json`); one —
the orientation `SessionStart` — is written to `~/.claude/settings.json`, a single **machine-wide**
entry. That placement is correct and deliberate: the hook's "spec present but MCP not registered"
branch must reach folders provisioning has never touched, and its content carries zero per-seat
state, so it satisfies the ADR 165 shared-slot invariant.

The hazard is not the placement. It is the **writer**.

`upsertHook` selects existing entries by **marker** (`# musterd-sessionstart-hook`) and never
compares **content**. Three consequences follow, and the third is what makes the first two invisible:

1. Any `musterd init`, anywhere on the machine, rewrites the shared hook for every folder.
2. If that `init` runs from an **older checkout**, it silently replaces the current hook text with its
   own older version — downgrading every seat at once, with no error and no output.
3. Nothing detects it. `inspectClaudeHookDrift` reports presence/absence only, so a hook that is
   present but stale reads as perfectly healthy.

This is precisely the ADR 165 "a stale writer re-bakes the shared slot" shape, transposed onto the
hook axis. ADR 165 could resolve its instance by **emptying** the slot, because the contested content
was per-seat state that did not belong there. That move is unavailable here: the hook's content is
the feature. There is nothing to remove — the slot legitimately holds shared behavior, and the
question is only _which version_ of it.

### The evidence is from this week, not a thought experiment

Rolling out the ADR 160 label-sweep trigger (#421) changed **only the hook's text**. Every musterd
health check reported zero hook drift on a seat still carrying the pre-fix text. The fix was
invisible to the entire doctor surface — it had to be verified by hand, by executing the string.

The same blindness is how the ADR 160 trigger can quietly disappear again: one `musterd init` from
any stale checkout on this machine silently reverts it, and `init --check` will call the result
healthy.

## Problem

The doctor's model of a hook is a boolean — _is an entry with our marker present?_ — but a hook's
value is entirely in its **text**. A marker says who wrote it. It says nothing about _when_, and
"when" is the only thing that distinguishes the current hook from a silent downgrade.

## Invariant

> A shared slot whose content is the feature cannot be emptied, so it must be **versioned**. A writer
> may install its own generation over an older one; it may never install it over a newer one, and a
> reader must be able to tell the two apart without guessing.

## Decision

Three changes, each small and additive.

**1. Stamp the hook with the generation that wrote it.** The global `SessionStart` command's marker
comment gains the writing build's `FEATURE_EPOCH`:

```
# musterd-sessionstart-hook e2
```

`FEATURE_EPOCH` is already the project's ritual for a client-visible capability change (ADR 148), and
a hook's text _is_ a client-visible capability, so this reuses an existing discipline rather than
minting a version scheme. An unstamped hook is legal and means "written before this ADR" — treated as
the oldest possible generation, never as an error.

**2. Refuse the downgrade.** `upsertHook` gains an epoch guard for the shared hook: if the entry it
is about to replace carries an epoch **greater** than this build's, it leaves the existing hook alone
and returns a warning naming both epochs and the repair (`musterd service refresh` on the stale
checkout). Equal or lower epochs overwrite exactly as today, so the common path is unchanged. This is
the half that stops the damage rather than merely reporting it, and it is deliberately asymmetric: a
newer build always wins, whichever checkout happens to run last.

**3. Make the doctor read content, not presence.** `inspectClaudeHookDrift` compares each installed
musterd-authored hook against the command **this build would generate**, and reports:

- _stale_ — installed text differs and its epoch is lower (or absent): the hook is a downgrade; name
  it and prescribe the repair.
- _ahead_ — installed epoch is higher than this build's: this checkout is behind, not the hook. The
  repair is to update the checkout, **not** to run `init` here — a distinction the presence-only
  check could never draw, and getting it backwards is what re-baked the slot in the first place.
- _matched_ — no line.

The global hook is machine-shared, so every folder's doctor reports it; that is one machine-level
fact repeated, not N problems, and the line says so.

### What this does not do

It does not make hook installation transactional, version the five project-local hooks' text
independently, or attempt to reconcile two checkouts that legitimately want different hooks. A single
machine-wide generation counter with a newest-wins rule is enough for the failure actually observed;
anything more needs a second live datum first.

## Observability & Evaluation

The instrument is the doctor line itself, and the honest risk is that it becomes noise — a drift line
every seat prints forever because one stale checkout exists somewhere on the machine.

**Guard metric — false-positive rate.** On a machine where every checkout is current, the expected
count of hook-content drift lines is **zero**. Any nonzero steady-state count means the comparison is
matching on incidental text (whitespace, shell quoting, an env difference) rather than on generation,
and the check is wrong. Measure by running `musterd init --check` across all 13 dogfood worktrees
after a fleet-wide refresh; the pass condition is 0/13.

**Value metric — does it catch the real thing?** The pre-registered test is the incident that
motivated this ADR, replayed: install the pre-#421 hook text, run `init --check`, and require exactly
one _stale_ line naming the hook. Today that returns clean, which is the defect. A second arm runs
the reverse — a deliberately-behind checkout against a current hook — and requires an _ahead_ line
prescribing a checkout update rather than an `init`.

**Downgrade-refusal arm.** Run `musterd init` from a checkout stamped at a lower epoch than the
installed hook and assert the hook file is **byte-identical** afterward, plus one warning. This is
the only assertion that proves the mechanism, because its whole purpose is that nothing happens.

**Where the numbers land.** Fleet sweep results go in this ADR alongside ADR 158's precedent (a
13-worktree sweep replacing an n=1 baseline). If the guard metric fails — steady-state nonzero on a
current fleet — the comparison narrows to the epoch stamp alone and stops diffing text at all.

## Consequences

- A hook downgrade becomes loud instead of silent, and the doctor stops reporting a stale machine-wide
  hook as healthy — closing the gap that made #421 unverifiable by any tool.
- Every capability change to a hook's text now carries a `FEATURE_EPOCH` bump as a real obligation,
  not a nicety. Forget it and the downgrade guard cannot distinguish the new text from the old.
- The doctor gains a per-folder line about a machine-wide fact. Accepted deliberately: there is no
  machine-level surface to report it on, and a repeated true line beats a missing one.
- An older CLI can no longer fully provision this machine's shared hook. That is the point, but it
  means a deliberate rollback now requires the rolled-back build to also be the newest epoch — i.e.
  rollback is an explicit act, not a side effect of running `init` in an old folder.

## Related

- [ADR 165](165-worktree-family-mcp-entry.md) — same shape, different resolution: that slot could be
  emptied, this one can only be versioned. The two together bound the pattern.
- [ADR 166](166-session-liveness-by-enumeration.md) — the session axis of the same shared-slot family.
- [ADR 160](160-seat-session-labels.md) — the trigger whose rollout surfaced this blind spot.
