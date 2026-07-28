# 171 — A provisioned workspace is long-lived: check against the template, not the receipt

- Status: accepted — 2026-07-28. Authored by ryder (lane `01KYKGEGSCDQ8XHBRAB1MJMT29`, opened by izzo
  2026-07-27 while rolling out `musterd init --refresh-hooks`). Number **171** — next free above
  ADR 170 at branch time.
- Date: 2026-07-28
- Builds on: [ADR 168](168-hook-content-drift.md) (hooks are content, not presence — this is its
  sequel, and the rule it applied to one file type), [ADR 161](161-init-defaults-to-the-folders-team.md)
  (`--refresh-guidance`, and the ruling that the full `init` flow is unsafe in a live seat's
  workspace), [ADR 159](159-long-lived-process-currency.md) (the currency doctrine for long-lived
  _processes_ — this is the same doctrine for long-lived _folders_),
  [ADR 085](085-layered-guidance-surface.md) (the guidance surface and its content stamp),
  [ADR 060](060-verify-provisioning-not-assume.md) (the doctor as the drift channel),
  [ADR 162](162-the-binding-registry-only-grows.md) (the registry that enumerates the fleet).

## Context

ADR 168 established that a hook's value is entirely in its text, and that a check driven by a
hand-maintained list is how a gap reappears. Its resolution was to drive the hook check off the
**marker table** — the set of hooks _this build would write_ — "so a hook added later is covered the
day it is added rather than the day someone remembers to extend the doctor."

That principle is right, and on the hook axis it is implemented: `LOCAL_HOOKS` is the expected set,
and `inspectClaudeHookDrift` compares against it.

Guidance files are the surface it never reached. `inspectGuidance` iterates
`readProvisionManifest(cwd)?.guidance.files` — **the set recorded at provisioning time**. It is a
receipt, and a receipt can only ever confirm the past.

The tell is in musterd's own source. `guidanceTargets()` is documented as "the removal set for
uninstall **and the expected set for the doctor**." Uninstall calls it. The doctor does not.

### The measurement

Across the 8 Claude Code dogfood worktrees on this machine, 2026-07-28:

| guidance file                                           | present in | drift lines about it |
| ------------------------------------------------------- | ---------- | -------------------- |
| `.claude/skills/musterd/SKILL.md`                       | 8 of 8     | —                    |
| `.claude/skills/musterd-label-sessions/SKILL.md`        | 8 of 8     | —                    |
| `.claude/skills/musterd-nudge-relay/SKILL.md` (ADR 167) | **0 of 8** | **0**                |

Every manifest was written on 2026-07-26 at `contentVersion: 5`, and none lists the nudge-relay
skill, because it did not exist when they were written. So the doctor does not report it missing —
it was never expected, and a file that is never expected can never be missed. A **0% detection rate
against a known positive**, which is the same shape and the same number ADR 168 recorded as its own
baseline.

What makes this precise rather than merely embarrassing is the contrast in the _same_ health run. The
version axis works exactly as designed and is loud about it:

```
✗ the musterd skill in .musterd/skill/SKILL.md is v5, current is v7 — run `musterd init --refresh-guidance`
✗ … .claude/skills/musterd/SKILL.md is v5 …
✗ … .claude/skills/musterd-label-sessions/SKILL.md is v5 …
✗ … .claude/commands/musterd-{standup,handoff,claim}.md is v5 …
```

Six lines about files that _changed_; zero about the file that never arrived. The check is not weak,
it is anchored to the wrong thing — and the anchor is invisible precisely because the axis it does
cover is so noisy.

### Two smaller defects found in the same read

- `inspectClaudeHookDrift`'s stale-hook line and the session-capture missing line both still
  prescribe bare `musterd init`. ADR 168's follow-through states that "every hook-drift line now
  names it instead of `musterd init`" — two do not, and they prescribe the one verb ADR 161 calls
  unsafe in a live seat's workspace, which is exactly where the line is read.
- The guidance version check emits **one line per file**: six lines above for a single fact. ADR 168
  pre-registered "becomes noise" as its own failure mode. This is that failure, already arrived.

## Problem

musterd delivers capability by writing into a folder, and it checks that writing against a record of
what it wrote. A record is structurally incapable of noticing an **addition** — only a change or a
deletion. Every capability shipped as a new file therefore reaches new workspaces immediately and
existing ones never, which is the inverse of what is wanted, since the long-lived workspaces are
where the work happens.

## Invariant

> A provisioned workspace is a long-lived artifact. Every check on what musterd wrote into one must
> be driven by **what this build would write today** — the expected set — never by a record of what
> was written at provisioning time.

musterd has now met this obligation for long-lived **processes** (ADR 152/159: the auto-refresher,
and `service refresh` bouncing every agent from the checkout it rebuilt) and for the shared **slot**
(ADR 165/168: stamp, refuse, compare). Long-lived **folders** are the third surface, and this is the
doctrine for them.

## Decision

### 1. Anchor the guidance check to the expected set

`inspectGuidance` iterates `guidanceTargets(h)` for each harness **configured in this folder** —
mirroring the existing `claudeConfigured` gate on the hook check, so a machine without Cursor never
gets phantom drift. Three outcomes, and the ordering matters:

- **expected, absent** → drift, naming that the file postdates this folder's provisioning and
  prescribing `--refresh-guidance`. This is the line that would have caught nudge-relay at 0-of-8.
- **expected, present, stampless** → the existing warn-only note ("treating it as yours"). Checking
  _existence_ before _expectation_ is what keeps a user-authored file at a managed path from becoming
  false drift, and it needs no manifest change: the skip is already visible on disk.
- **recorded but no longer expected** → a retired file. Silence. Not every removal is drift, and a
  doctor that nags about a path musterd itself stopped writing is worse than one that says nothing.

The manifest keeps its job — it remains the exact removal set for uninstall (ADR 030). What it stops
being is the health check's source of truth.

### 2. Take the noise criterion seriously

Collapse the per-file version lines into one line per surface ("6 musterd guidance files are v5,
current is v7"), and correct the two hook lines that prescribe the unsafe verb. ADR 168 named noise
as a failure mode of its own instrument; a sequel that adds a line while leaving six redundant ones
in place has not taken its own criterion seriously.

### 3. Enforcement coverage is measured, not assumed

Any dogfood-derived compliance claim states measured gate coverage over its population at run time.
This is now cheap rather than aspirational: with §1, `musterd init --check --json` reports a folder's
true artifact coverage, so a population's coverage is a loop, not a census by hand.

The cookoff cells were in fact gated exactly where they claimed to be — a census confirmed the ADR 150
gate hook present in every enforcement arm and absent from every baseline arm, so finding 006 and the
8/8 claim-rate replication stand unaltered. But nobody knew that until the census. The number was
unmeasured, not wrong, and an unmeasured precondition is one that will eventually be wrong without
announcing itself.

### 4. Automatic delivery is deferred, and the gate on it is falsifiable

The obvious next move is a periodic fleet sweep: enumerate provisioned folders from the binding
registry (ADR 162), skip entries whose folder is gone, run `--refresh-hooks` and `--refresh-guidance`
in each. Two constraints are already decided by prior ADRs should it be built:

- **Host it on the ADR 166 liveness sweep, not the auto-refresher.** The auto-refresher's job is the
  daemon's own checkout — `refreshDaemon` deliberately targets that one folder. The liveness sweep is
  already `StartInterval`, already machine-wide, already in the business of enumerating a fleet.
- **The sweeper runs from the daemon's checkout.** ADR 168's downgrade refusal exists because a stale
  checkout can re-bake a shared slot; a sweeper running from an arbitrary worktree would _be_ that
  hazard, on a cadence, across every folder. Running from the checkout ADR 152 keeps current is what
  separates a safe periodic writer from the fastest way to propagate a downgrade.

It is deferred because the evidence for it does not exist yet. Everything above is detection, and
detection has never been tried on this axis — the fleet spent eight days at 2-of-13 gate coverage
under a policy of on-demand repair, but with **no drift line to ignore**. "Loud detection is
insufficient" is a claim about human behavior that this ADR is not entitled to assume, and the
experiment below is designed so it can fail.

Self-healing at `SessionStart` — a seat repairing its own folder on every start — is considered and
**rejected**. It makes a write to a shared slot incidental to every session start, which is the rule
ADR 168 exists to hold, and it carries an unresolved correctness question: a hook installed during
`SessionStart` plausibly does not take effect until the _next_ session, which would leave it unable
to self-heal the reachability hooks it is most needed for. A mechanism that cannot repair its most
important case is not the mechanism.

## Observability & Evaluation

**Traces.** No new ledger events, for ADR 168's reason and it applies unchanged: a folder's contents
are a fact about a filesystem, not about a seat's work, and an audit row would attribute a
machine-level condition to whichever seat happened to run the doctor. The surface is the doctor's own
output plus `musterd init --check --json`, which §3 promotes from a convenience to the instrument a
coverage claim is read off.

**Eval — dataset and baseline.** The dataset is the **Claude Code subset** of the 13 dogfood
worktrees ADR 168's fleet sweep used — 8 of the 13, since the remaining five are wired to harnesses
that place guidance elsewhere and would answer a different question. The baseline is measured, not
estimated: the ADR 167 nudge-relay skill is
present in **0 of 8** and the doctor emits **0** drift lines naming it — 0% detection against a known
positive. The post-change target on that same condition is 8/8.

Two guard metrics run the other way. On a fully current fleet the expected count is **0**; any
nonzero steady state means the expected set is over-broad — expecting files for an unconfigured
harness, or a path musterd retired — and the check is wrong rather than the fleet. And a folder must
emit **one** version line per surface where it emits six today; a regression there is the noise
failure mode returning under a new name.

**Experiment.** Four pre-registered arms, all runnable before merge:

1. _Replay the incident._ A manifest that predates a guidance file, with that file absent: require
   exactly one drift line naming it as added after provisioning. Today this returns clean, and the
   clean result **is** the defect.
2. _Stampless user file at a managed path._ Require a warn-only note, never drift. This is the arm
   that catches an expected set that has become presumptuous about files it did not write.
3. _Unconfigured harness._ A folder with only Claude Code wired must produce zero Cursor guidance
   drift.
4. _Retired path._ A recorded path no longer in `guidanceTargets()` must produce silence.

Only arm 1 fails against pre-change code. Arms 2–4 are regression guards that pass both before and
after, and saying so is the point: four passing arms would otherwise imply four defects measured,
when one was. ADR 168 drew this distinction about its own sixth assertion and it is worth keeping.

**The experiment that decides §4.** The trigger is the next guidance file or hook added to the
templates after this lands. Measure fleet coverage **7 days** after that change merges — long enough
that a drift line has been read at a session start in most seats, short enough that the answer is
about the mechanism rather than about the week. Below 100%
without a sweep ⇒ loud detection was insufficient and the periodic sweep is earned, with the
constraints in §4 already settled. At 100% because someone acted on a now-visible drift line ⇒ the
sweep is **never built**, and that is a success rather than a retreat: the cheapest mechanism that
holds the invariant is the correct one, and a background writer into thirteen live workspaces is not
a thing to build on suspicion.

**Kill criterion.** If arm 1 passes but a guard metric fails, the expected set narrows back toward
the recorded set and the change is reverted rather than tuned — a health check that invents drift
costs more than one that misses it, because the first teaches people to stop reading.

## Consequences

- A capability delivered as a new file is now covered the day it is added, on both surfaces musterd
  writes into. The asymmetry where fresh workspaces are always correct and long-lived ones silently
  rot is closed on the detection axis.
- The manifest stops being load-bearing for health. It remains the exact removal set for uninstall,
  which is what ADR 030 built it for; using it as the expected set was the category error.
- The doctor gets quieter and more informative at the same time — six lines become one, and the line
  that was missing appears.
- A dogfood compliance claim now owes a coverage number. That is a real obligation on future
  experiment write-ups, taken deliberately: the alternative is a precondition nobody measures until
  someone thinks to census it.
- Nothing yet repairs a folder without a human or an agent choosing to. That is the known remaining
  gap, and §4 names the evidence that would close it rather than leaving it implicit.

## Related

- [ADR 168](168-hook-content-drift.md) — the same invariant on the hook axis. This ADR is its rule
  applied to the surface it stopped short of.
- [ADR 159](159-long-lived-process-currency.md) — the process axis. "A currency policy that depends
  on somebody remembering" is the sentence this ADR is written against.
- [ADR 150](150-structural-inducement-pretooluse-gates.md) — the enforcement class whose coverage §3
  makes a measured precondition.
