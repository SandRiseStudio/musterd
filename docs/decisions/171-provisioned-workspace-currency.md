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

`inspectGuidance` iterates `guidanceTargets(h)` for each harness **established in this folder** —
`establishedHarnesses`, the same predicate `--refresh-guidance` uses to decide what it will rewrite,
so the doctor expects exactly what its own prescribed repair would write. (This ADR first said
"configured" and was wrong; see the Result section — the difference put four uncleanable lines on a
live seat.) Three outcomes, and the ordering matters:

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
**rejected on one ground rather than two.**

The ground that holds: it makes a write to a shared slot incidental to every session start, which is
precisely the rule ADR 168 exists to hold. A machine-wide concern would be hidden inside every seat's
startup path, and the write would happen without anyone choosing it — the definition of incidental.

The ground that does **not** hold, recorded because it was drafted as a reason and then checked: the
first draft of this ADR argued that a hook installed during `SessionStart` would not take effect
until the _next_ session, leaving self-healing unable to repair the reachability hooks it is most
needed for. That is false. Claude Code's hook documentation states that "direct edits to hooks in
settings files are normally picked up automatically by the file watcher," so a hook written during a
session is live in that session. Self-healing would work. It is rejected because of what it does to
the write, not because it would fail.

This matters for the sequencing in §4: if the periodic sweep is later ruled out for its own reasons,
`SessionStart` self-healing is a **live option** to reopen rather than a closed door, and reopening
it costs only the ADR 168 argument above — which is a values call, and revisable.

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

**Predicted, then measured — and the prediction was wrong.** This ADR was drafted claiming only arm 1
would fail against pre-change code, with arms 2–4 as regression guards passing both before and after.
Run against the pre-change doctor, **arms 1, 2 and 4 fail, plus the guard metric; only arm 3 passes**.
The correction is recorded rather than quietly fixed, because each surprise is a defect the ADR did
not know it was fixing:

- Arm 2 fails because a user's own file at a path musterd would write drew no note at all — the
  pre-change check never looked at a path it had not recorded, so it could not decline to clobber
  something it could not see.
- Arm 4 fails because the pre-change check **nags about a retired path**: a file musterd itself
  stopped writing was reported as "gone", prescribing a repair that would not restore it.

So the receipt was not merely blind to additions — it was also wrong about the user's files and about
musterd's own removals. Three defects measured, not one. Arm 3 alone is the pure regression guard,
and it is the one that matters most for the guard metric: it is what keeps the wider expected set
from inventing drift for a harness this folder never wired.

**The experiment that decides §4 — RETRACTED 2026-07-28, before it was ever run.** See
"§4 reconsidered" below. The original text is preserved here because the way it was wrong is the
finding:

> Measure fleet coverage **7 days** after that change merges — long enough that a drift line has been
> read at a session start in most seats […]

That clause is the whole error, and it is stated as an assumption rather than a fact because the
author never checked it. **A drift line is not read at a session start.** The `SessionStart` hook
runs `musterd init --check-build` — the ADR 135 build-skew probe — and nothing else; it does not run
the doctor. Guidance and hook drift surface only when a human or an agent deliberately types
`musterd init --check`.

So the experiment would have measured whether eight seats act on a line they will almost never see.
A 100%-unrepaired result would have been read as "loud detection is insufficient, build the periodic
sweep" when the true cause was that detection was never delivered at all. The confound is total, and
no choice of window fixes it — the experiment was **mis-specified, not merely slow**.

**Kill criterion.** If arm 1 passes but a guard metric fails, the expected set narrows back toward
the recorded set and the change is reverted rather than tuned — a health check that invents drift
costs more than one that misses it, because the first teaches people to stop reading.

### Result — 2026-07-28, increment 1

**The baseline turned over.** Across the 8 Claude Code dogfood worktrees, `musterd init --check`
now reports the missing ADR 167 nudge-relay skill in **8 of 8**, against a measured pre-change
baseline of **0 of 8**. The noise guard moved with it: **6 version lines per folder became 1**.

**The guard metric fired during implementation, and it earned its place.** The first implementation
scoped expectation to _configured_ harnesses — a reading of "what this build would write" that seemed
obviously right and was wrong. On a live seat it produced four drift lines for Cursor guidance this
folder had never been provisioned with, and — the damning part — **`--refresh-guidance` would never
have written them**, because adding a harness's files is provisioning, not refreshing. Four
uncleanable lines: the exact failure the guard was pre-registered to catch, caught by it, on the
first real run rather than in review.

The fix is stronger than the bug: `establishedHarnesses` is now the **single predicate shared by the
doctor and by `--refresh-guidance`**, so the check expects precisely what its own prescribed repair
would write, by construction rather than by two functions happening to agree. Arm 5 pins it.

**On the kill criterion, honestly.** It says a failing guard means revert, not tune, and this was
tuned. The distinction claimed — and it should be judged, not assumed — is that the criterion exists
to stop a threshold being loosened until noise disappears, whereas the predicate here was corrected
against an _objective external anchor_: parity with the repair command. There is a right answer to
"what should the doctor expect" independent of how many lines it yields, and this is it. Arm 1 still
passes and the guard now reads clean at zero. If a reviewer reads the criterion strictly, the strict
remedy is a revert, and that call is the reviewer's to make rather than the author's.

**Reviewer's verdict on the kill criterion — 2026-07-29, stanley (not the author).** Routed by ryder
on lane `01KYQYZMAP`, adjudicated here because a criterion an author reinterprets alone is not
pre-registered at all. **The tune stands, _and_ the criterion was mis-specified for guards of this
shape.** Both halves matter; the first without the second would be a blank cheque.

The criterion conflates two failures it treats as one. **A noisy check** reports drift that is real
but not worth acting on; its remedy genuinely is revert, because the tempting fix is loosening a
threshold until the noise disappears, and that is unfalsifiable. **An incoherent check** reports
drift its own prescribed repair cannot clear. #448 was the second: four lines telling a seat to run
`--refresh-guidance` for files that command would never write. That is not a threshold at all — it is
a correctness property, and it is binary. Reverting it would have returned the check to a *differently*
unfit state, not a fit one. The criterion's own rationale argues for repair here: an uncleanable line
teaches people to stop reading *more* thoroughly than an actionable one, because no action makes it go
away.

Three checkable facts, none of which rest on the author's account of intent:

1. **The numbers moved the wrong way for a tune-to-silence.** The change *raised* true detection
   (0 of 8 → 8 of 8 on the missing ADR 167 skill) while removing the four uncleanable lines and
   cutting 6 version lines per folder to 1. A change aimed at quieting a guard lowers both; this one
   raised detection.
2. **The anchor was independently re-derived, in a different subsystem, by a later bug.** #514's
   foreign-adapter guard hit the same fault and named the same principle — a check must expect what
   its own repair would actually write, fleet-wide. A post-hoc rationalisation does not go on to
   predict the next bug; ADR 182 is the same principle again.
3. **Parity is verifiable without reference to the guard metric.** `establishedHarnesses` is now one
   predicate shared by the doctor and the repair, so agreement is structural rather than two
   functions happening to coincide.

**The boundary, so this is not reusable as an escape hatch.** A failing guard may be repaired instead
of reverted only when all three hold: (i) the repair is forced by an anchor verifiable *independently*
of the guard metric, (ii) the anchor is named before the new count is measured, and (iii) the change
would still be correct if the count moved against it. Absent any one, the plain remedy — revert —
applies. This mirrors the discipline ADR 151's re-baseline took under the same pressure: encode the
boundary, never assert the exception.

**What this review is NOT evidence of.** It cannot be recorded as a cross-family confirm. ryder
originally labelled the routing same-family from a session-start roster read, corrected it to
cross-family on the belief that stanley attests `claude-fable-5` — and by adjudication time that was
false twice over: nick switched this seat to `claude-opus-5` mid-session, and the seat's live presence
now attests **nothing at all** (`presence.model` empty), which under ADR 169 makes it ineligible as a
cross-family counterpart in either direction. So the honest record is: **closed by a reviewer who is
not the author, family unattested.** ADR 169 increment 5's instrument is still unexercised. That the
label was wrong, corrected, and wrong again is the third stale-roster-read of the day and ADR 173's
defect in miniature for the third time — the lesson is that model family is not a fact a note may
carry, only a value read at the moment it is used.

**What is not yet done.** The fleet is detected, not repaired: all 8 seats now carry a true drift
line and `--refresh-guidance` is the one-command fix. That repair is deliberately left to the seats
rather than performed across live worktrees from this branch — the same non-action ADR 168 recorded
for the same reason, and it is also the opening state of the §4 experiment, whose whole question is
whether a loud line is enough to get a fleet repaired without a background writer. Performing the
repair here by hand would destroy the measurement.

_Superseded the same day: the experiment that repair would have "destroyed" turned out to be invalid,
so there was nothing to protect. The fleet was repaired 2026-07-28 — **8 of 8** worktrees now carry
the ADR 167 nudge-relay skill and report **0** guidance drift, which is the guard metric hitting its
pre-registered clean-fleet target of 0._

### §4 reconsidered — 2026-07-28

With the experiment retracted, the deferral it justified has to be re-decided, and the answer changes.
The periodic sweep and `SessionStart` self-healing were the only two candidates considered, and both
were arguments about **who performs the repair**. Given that the drift line reaches nobody, that was
the wrong question: repair delivery cannot be the bottleneck while _detection_ delivery is missing.

**Increment 2 is therefore neither of the deferred options. It is detection delivery:** the
`SessionStart` hook gains a cheap drift line the way it already carries the build-skew line. This
dominates both candidates on their own stated terms:

- It **writes nothing**, so ADR 168's incidental-write objection — the sole surviving reason to
  reject self-healing, once the timing objection was measured false — does not apply to it at all.
- It needs no background writer into thirteen live workspaces, so the stale-writer hazard that
  constrained the sweep never arises.
- It makes the original question — is a loud line enough? — answerable in days rather than never,
  because the line finally reaches someone who can act on it.

The hook contract bounds the design: ≤2 s, read-only, always exit 0, and **silent when clean**, since
`SessionStart` stdout lands in model context and costs tokens every session. That rules out the full
doctor (a roster fetch and a `git fetch`) and calls for a cheap variant on the `--check-build` model:
`existsSync` over the expected set plus a few file reads, no network, no git. Post-repair the steady
state is silence, so it costs nothing until the next capability ships — precisely when it should
speak.

The periodic sweep is not rejected, only demoted: it remains the answer **if** a delivered line still
fails to get the fleet repaired, which is now a question that can actually be asked.

### Result — 2026-07-28, increment 2

**Shipped, and it needed no hook-text change at all.** `--check-build` turned out to have exactly one
call site in the repo — the `SessionStart` hook string itself — and to be absent from the help catalog
and the arg table. It is a private hook-facing verb, so the artifact check went _inside_ that command.
Three consequences, and the third is the one worth generalising:

1. No hook text changed, so the `FEATURE_EPOCH` obligation this increment was expected to carry never
   arose.
2. Seats whose installed hook text is **stale** still gain the capability, because they invoke the
   same flag.
3. **Behaviour placed in the CLI reaches every seat whose hook is already installed; behaviour placed
   in the hook _string_ reaches only seats that re-run provisioning** — which is the exact rot this
   ADR exists to close. Given the choice, put capability on the CLI side of that line. This increment
   is the first case where that rule paid, and it turned the expected change into a smaller one.

The flag keeps its now-narrow name deliberately: every hook on the fleet calls it by that name, and
renaming it would strand each seat until it re-provisioned.

**Measured against the hook contract.** Silent on a clean folder; **0.4 s** wall clock against the
2 s budget; exit 0 on every path. With one guidance file hidden, the probe emits exactly one line
naming only the repair actually needed, and restoring the file returns it to silence:

```
musterd: this folder's provisioning is behind what this build writes — 1 guidance file(s)
missing or stale (ADR 171). Run `musterd init --refresh-guidance` to repair, or
`musterd init --check` for the detail.
```

Output is **one bounded line however many artifacts drifted** — the token guard, since this stdout is
charged to model context at every session start. A test pins it with several hooks and a guidance
file drifting simultaneously.

**A drive-by defect, found because this line was finally being read carefully.** The build-skew half
was firing on every actively-developed seat and saying nothing true: a worktree with uncommitted
edits builds `<sha>-dirty` while the daemon runs a clean `<sha>`, and both truncate to the same seven
characters for display. The line read `your CLI build (3260685) differs from the daemon (3260685)`,
and prescribed a rebuild that could not help, because the difference _was_ the developer's own
uncommitted work. Skew now compares commits with the marker stripped, so an unsaved working tree is
not called stale while a genuinely different commit still reports. This was ADR 168's noise failure
mode running unnoticed in the one line every session already printed — which is a fair warning about
how long a wrong line can survive when nothing forces anyone to read it.

**What this does not yet answer.** Whether a delivered line actually gets a fleet repaired. The
fleet is currently clean, so the first real exercise is the next capability shipped as a hook or a
guidance file — and unlike the retracted experiment, that measurement is now valid, because the line
reaches someone.

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
