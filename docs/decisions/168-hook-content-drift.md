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

musterd installs a set of Claude Code hooks — six at the time of writing, seven once ADR 167
increment 1 lands its session-messaging `PreToolUse` entry, and the count is expected to keep
growing, which is part of the point. All but one are project-local
(`.claude/settings.local.json`); the exception — the orientation `SessionStart` — is written to
`~/.claude/settings.json`, a single **machine-wide** entry. That placement is correct and deliberate: the hook's "spec present but MCP not registered"
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
# musterd-sessionstart-hook e3
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

The comparison is driven off the **marker table**, not a hand-maintained list of checks, so a hook
added later is covered the day it is added rather than the day someone remembers to extend the
doctor. ADR 167's session-messaging `PreToolUse` entry is the first beneficiary and the reason this
is stated as a requirement: a presence-only doctor that must be extended per hook is exactly how the
gap reappears.

### What this does not do

It does not make hook installation transactional, version the five project-local hooks' text
independently, or attempt to reconcile two checkouts that legitimately want different hooks. A single
machine-wide generation counter with a newest-wins rule is enough for the failure actually observed;
anything more needs a second live datum first.

## Observability & Evaluation

The instrument is the doctor line itself, and the honest risk is that it becomes noise — a drift line
every seat prints forever because one stale checkout exists somewhere on the machine.

**Traces.** This ADR adds **no new ledger events**, and that is a deliberate call worth stating
rather than leaving as an omission. A downgrade is a fact about a machine's filesystem, not about a
seat's work, and the two existing candidates both mislead: an audit row would attribute a
machine-wide condition to whichever seat happened to run the doctor, and the daemon cannot observe
`~/.claude/settings.json` at all. So the trace surface is the **doctor's own output** — the `stale` /
`ahead` lines from `musterd init --check`, which are already the established drift channel (ADR 060)
and are read by a human or an agent at session start. The refusal path additionally emits one
warning at `init` time naming both epochs. If the fleet sweep below shows downgrades happening
repeatedly rather than once, that is the datum that would justify promoting this to a real ledger
event; one incident does not.

**Eval — dataset and baseline.** The dataset is the **13 dogfood worktrees** on this machine, the
same population ADR 158's fleet sweep used, each contributing one `musterd init --check` run plus the
epoch stamp on the shared hook. The baseline is today's behavior, and it is a precise and damning
number: on a machine that provably carried a stale hook (the pre-#421 text, confirmed by hand), the
doctor reported **0 hook-content drift lines out of 13** — a 0% detection rate against a known
positive. The post-change target on that same replayed condition is 13/13.

The guard metric runs the other direction: on a fleet where every checkout is current, the expected
count is **0/13**. Any nonzero steady state means the comparison is matching incidental text
(whitespace, shell quoting, an env difference) rather than generation, and the check is wrong rather
than the fleet.

**Experiment.** Three pre-registered arms, all runnable before merge:

1. _Replay the incident._ Install the pre-#421 hook text, run `init --check`, require exactly one
   `stale` line naming the hook. Today this returns clean — that clean result **is** the defect.
2. _Reverse the polarity._ Point a deliberately-behind checkout at a current hook; require an `ahead`
   line prescribing a checkout update and **not** an `init`. This is the arm that catches getting the
   direction backwards, which is precisely how the slot got re-baked in the first place.
3. _Prove the refusal._ Run `musterd init` from a lower-epoch checkout against a higher-epoch
   installed hook; assert the settings file is **byte-identical** afterward, plus one warning. This
   is the only assertion that can prove the mechanism, because its entire purpose is that nothing
   happens.

**Kill criterion.** If arm 1 passes but the guard metric fails — steady-state nonzero on a current
fleet — the comparison narrows to the epoch stamp alone and stops diffing hook text entirely. Results
land in this section, following ADR 158's precedent of replacing an anecdote with a fleet number.

### Result — 2026-07-27, implementation (`izzo/adr-168-impl`)

All three arms pass as unit tests, and — the part that matters — **five of the six new assertions
fail against the pre-change code**, so they measure the defect rather than restating the
implementation. (The sixth is the guard metric, which asserts the _absence_ of noise and correctly
passes both before and after.)

Arm 1 also reproduced **live on this machine**, unprompted, on the first read-only `musterd init
--check`:

```
✗ the machine-wide Claude Code SessionStart orientation hook (~/.claude/settings.json) does not
  match what this build would write (installed epoch 0, this build 3) — it is present but STALE
```

That is the ADR's baseline turning over in one step: the same doctor that scored 0 detections
against a known positive now names it, with the epochs that prove it. `installed epoch 0` is the
unstamped hook this ADR predicted — written before the stamp existed, and until now indistinguishable
from current text.

One deliberate non-action worth recording: the obvious next move was to run `musterd init` here and
clear the line. Doing that from an unmerged branch build would have rewritten the machine-wide hook
for every folder from code that had not landed — the precise hazard this ADR exists to prevent. The
repair waits for the merged build.

### Follow-through — `--refresh-hooks`, and the delivery gap it exposed

Performing the repair above surfaced a defect in this ADR itself: its prescription, "Run `musterd
init`", had **no safe form**. `--refresh-guidance` deliberately skips hooks (ADR 161); the full flow
is interactive, re-mints identity, and re-points the worktree-family MCP entry (ADR 165); and ADR 161
states outright that the full flow is unsafe in a live seat's workspace — which is exactly where the
drift line is read. A doctor line that prescribes a command nobody can safely run is half an
instrument.

Measuring the fleet turned that ergonomic complaint into a real finding. Across the 13 dogfood
worktrees:

| hook                                | installed in |
| ----------------------------------- | ------------ |
| `musterd-sessionmsg-hook` (ADR 167) | **0 of 13**  |
| `musterd-gate-hook` (ADR 150)       | **2 of 13**  |

So a declared enforcement class was **silently a no-op in most seats**. It fails open, so nothing
broke and nothing complained. The cause is the same one this ADR is about, one level up: a hook added
after a seat was provisioned reached it only by re-provisioning, and re-provisioning was unsafe — so
hooks had no delivery mechanism at all, and the fleet quietly diverged.

`musterd init --refresh-hooks` is that mechanism: hook entries only, no prompts, no member mint, no
binding write, no MCP re-registration, honoring the downgrade refusal above and exiting non-zero when
it fires. Every hook-drift line now names it instead of `musterd init`.

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
