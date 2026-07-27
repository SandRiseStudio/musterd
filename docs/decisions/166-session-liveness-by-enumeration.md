# 166 — Session liveness by enumeration: ask the harness what it has, don't keep a slot

- Status: draft — 2026-07-27. Authored by stanley (lane `01KYJF8QAFHDSM79Z08766BY68`).
  Number **166 pinned** — 164 is the highest on `origin/main`, and **165 is reserved** by izzo's
  open PR #400 (worktree-family MCP entry). That ADR number has already collided three times; taking
  166 rather than the nominally-free 165 is deliberate.
- Date: 2026-07-27
- Builds on: [ADR 131](131-harness-residency-wake-ledger-host.md) §5 increment 4 (`binding.session`,
  the capture this ADR demotes), [ADR 164](164-session-attested-presence.md) (which recorded this
  defect as its explicit non-fix), ADR 165 (izzo, PR #400 — spec merged ahead of its ADR file;
  the shared-slot shape argument whose test this ADR answers), [ADR 068](068-workspace-scoped-displacement.md)
  (what a wrongly-permitted spawn costs), [ADR 057](057-ambient-agent-presence.md) (liveness from
  real artifacts, not assertions).

## Context

`binding.session` is one slot per workspace, written unconditionally by the `SessionStart` hook. It
means _"the most recent session **started** here"_. Every consumer reads it as _"**the** session"_.

Those are different claims whenever more than one session has ever started in a workspace — which is
routine, because `claude -p` one-shots, resumes, and tooling runs all start sessions.

### Measured, twice, an hour apart

| workspace        | the slot says                                                | the truth                                           |
| ---------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| `agents-miley`   | capture `c2c6c365`, 2s lifetime, transcript never written    | session `40930804` alive since the previous evening |
| `agents-stanley` | capture `4aea2026`, `ended_at` set, transcript never written | session `079ec165` alive and writing                |

The second one is the seat that was investigating the first. Two independent instances inside one
hour is not a rare edge case, and the second arrived while this ADR's author was watching for it.

### What the wrong answer costs

`localSessionLiveness()` is the sole input to the wake backend's defensive rule — _"this backend must
never spawn, fresh OR resume, beside a live local session, regardless of caller"_
(`packages/cli/src/host/backends/claudeCode.ts:348`). Probed directly, `agents-stanley` returns
`resumable`: **no live local session**, for a workspace whose session is alive.

Both failure modes then compound:

1. The guard permits a spawn beside a live session — ADR 131 wake spend, and the newcomer displaces
   presence under ADR 068.
2. `resumeLadder` reads the same phantom, finds its transcript missing, and skips resume — so the
   spawn it just wrongly permitted is a **fresh, full-price** one rather than a resume.

The mechanism meant to prevent an expensive mistake selects the most expensive version of it.

### The shape, and the test it has to pass

izzo's ADR 165 names the pattern this shares with the worktree-family MCP entry: _one shared slot,
many legitimate claimants, and the obvious repair — make the slot mine — steals it from whoever holds
it._ Her remedy is **empty the slot, do not partition it**, because partitioning needs a key the
writer does not have at write time.

She was explicit that the remedy might not transfer, and set the test: _does `binding.session` have
an equivalent already-authoritative per-claimant fallback?_ If not, the analogy stops at the
diagnosis.

**It does.** The harness already keeps one file per session, named after that session, in a directory
derivable from the workspace path alone: `~/.claude/projects/<slug>/<session-id>.jsonl`, where the
slug is the absolute path with `/` → `-` (verified for `agents-miley`, `agents-stanley`, `agents`).
Its mtime _is_ liveness. It needs no key the writer lacks, because the harness names the file after
the session it belongs to.

Measured across four worktrees at the same instant: **enumeration 4/4 correct, the slot 2/4 wrong.**

## Problem

Liveness is read from a slot that records a different question than the one being asked, when the
harness is already maintaining the correct answer on disk, per session, enumerable without a key.

## Decision

**Ask the harness what sessions it has, rather than keeping a slot that claims to know.**

`localSessionLiveness(workspace)` derives its judgement by enumerating the harness's own per-session
transcripts. `binding.session` stops being the source of truth.

### Mechanism

**Amended 2026-07-27 after increment 1 — attribution is by recorded `cwd`, not by directory name.**
The shipped mechanism first decoded Claude Code's `~/.claude/projects/<slug>` directory name back
into a path (slashes → dashes). The fleet sweep killed that on its first run: a live session was
invisible because it ran in a nested worktree whose slug is `-Users-nick-agents--claude-worktrees-…`
— the dot replaced — while `.claude` and `.pnpm` elsewhere in the same tree **keep** their dots. The
encoding is undocumented and not self-consistent, so decoding it is a guess, and this guess would
have demoted a live session: the exact defect this ADR exists to fix, reproduced inside its own fix.

Attribution now uses what the harness _records_ rather than how it _names_. Every transcript entry
carries a `cwd`; a transcript belongs to the workspace `findWorkspaceDir` resolves from it — the same
walk-up rule that decided which binding the `SessionStart` hook wrote to. Measured on the live tree:
689 transcripts, 664 attributable, ~256 ms for a full scan, memoised for a second so a fleet sweep is
one scan. A transcript with no recorded `cwd` stays **unattributed** rather than guessed at.

**What increment 1 actually shipped, which is not what this section first described.** The plan was
an optional `enumerateSessions?` on the `Harness` interface, beside `observeModel`. It shipped instead
as a standalone module, `packages/cli/src/session/enumerate.ts`, called directly by
`localSessionLiveness`:

```ts
enumerateClaudeSessions(workspace, home?, now?): SessionFile[] | undefined; // { id, path, mtime, bytes }
```

The harness seam is deferred to the increment that needs it. Attribution turned out to be a property
of the _transcript_ (its recorded `cwd`) rather than of the harness's naming, so a single scanner
serves every harness that writes transcripts at all, and there is nothing per-harness to dispatch on
until a harness appears that stores sessions somewhere else entirely. Adding the interface slot now
would have been a seam with one implementation and no second caller — and the ADR would still have
been describing something that did not exist.

`undefined` means **"cannot tell"** and `[]` means "genuinely none"; the id is the transcript's
basename, the mtime is liveness, and the byte count feeds the existing context-hygiene bound.

`ended_at` becomes redundant rather than wrong: a transcript that stopped being written is not live,
and resumability is already judged by the GC horizon. Nothing distinguishes a cleanly-ended session
from a crashed one in today's behaviour either — both read `resumable`.

### Where this is weaker than ADR 165, stated plainly

izzo can empty her slot outright. **This one cannot**, and pretending otherwise would be the same
overreach this lane's sibling ADR was corrected for twice.

Enumeration is **harness-specific**. Claude Code has a per-session transcript store; Codex and Cursor
may not. So a harness with no enumerator keeps today's slot-based judgement, unchanged, with today's
risk. The slot is **demoted to a fallback for harnesses that cannot enumerate**, not deleted. Only
once every supported harness enumerates does the strong form of izzo's remedy become available, and
that is a later ADR with evidence behind it, not a promise made here.

### The two questions are not one question

Today one verdict feeds two consumers whose failure directions are **opposite**:

| consumer          | question                           | safe answer when unsure   |
| ----------------- | ---------------------------------- | ------------------------- |
| the spawn guard   | is a session live here?            | **yes** — refuse to spawn |
| the resume ladder | is there a session worth resuming? | **no** — go fresh         |

Collapsing them into one enum is why "no live session" and "nothing to resume" get answered by the
same phantom. A wrongly-refused wake costs a delay; a wrongly-permitted one costs money and
displaces a live seat. The judgements split so each can be wrong in its cheap direction — the same
asymmetry argument that corrected ADR 164, applied before it bites rather than after.

### Increments

1. **Enumerate in shadow.** Ship `enumerateSessions` and compute both judgements on every wake
   decision. **Act on the old one.** Log the pair and whether they disagreed. _Shipped (#403, #406)._
2. **Flip**, once increment 1 shows the disagreement rate and its direction. _Shipped (increment 2)._
   `localSessionLiveness` returns the enumerated verdict as `state` (`source: 'enumerated'`) whenever
   the harness can enumerate; the slot's counter-verdict is recorded as `slotState` so disagreement
   stays observable, and a `demoted` flag marks the flip-blocking direction (slot says live,
   enumeration disagrees — eval item 3). Harnesses that cannot enumerate keep the slot verdict
   unchanged (`source: 'slot'`). The slot capture still rides along as resume material — the resume
   ladder stays slot-fed until increment 3 splits the questions; an enumerated verdict over an empty
   slot skips resume rather than crashing. Flip evidence at the moment of flipping: sweep 23
   judgeable, 2 disagreed, 1 dangerous (`agents-izzo`: slot `resumable`, enumeration `live` across
   17 sessions — a spawn the slot would have permitted beside a live session), 0 in the inverse
   flip-blocking direction. Post-flip the same sweep reads that case as **caught**, 0 demoted.
3. **Split** the guard question from the resume question, each failing in its cheap direction.
   _Shipped (increment 3)._ The **guard** resolves disagreement toward live: the backend defers when
   _either_ the enumerated verdict or the demoted slot (`slotState`) says `live` — a wrongly-refused
   wake costs a delay, the cheap direction. The **resume** ladder keeps preferring a usable slot
   capture, but when the slot names nothing usable (empty, foreign harness, missing transcript) and
   enumeration judged the workspace `resumable`, it resumes the enumerated newest session — closing
   the compounding failure from the Context, where a phantom slot forced a full-price fresh spawn.
   Anything short of a confident target (no enumerated id/bytes, over the hygiene bound) still
   degrades to fresh, the resume question's cheap direction. Evidence-of-absence (`none` with an
   empty enumeration) still spawns quietly — only _conflict_ resolves toward live; refusing on a
   genuinely-empty workspace would break fresh-first for every new worktree.
4. **Retire the slot** for enumerating harnesses — gated on every supported harness having an
   enumerator, not scheduled here.

Shadow-first is not caution for its own sake. This lane's sibling ADR shipped two designs that looked
correct, passed their tests, and were wrong about live sessions in ways only a live probe caught. The
cheap way to find the third one is to run the new judgement against real wakes without letting it
decide anything.

## Observability & Evaluation

**Traces.** The wake decision's audit detail gains `liveness_source` (`enumerated` | `slot`), both
verdicts while increment 1 is in shadow, and `liveness_disagreed`. The disagreement flag is the whole
point: it is the only signal that says how often the slot is lying in production rather than in the
two cases someone happened to look at.

**Amended — the pre-registered dataset is too sparse to gate on.** This ADR said to flip "once
increment 1 shows the disagreement rate ... on real wake decisions". Measured afterwards: the daemon
has recorded **31 wake leases in total, 1–3 per day**, and a disagreement is only observable when a
wake lands on a workspace that happens to hold a phantom. That reaches useful n in months. The gate
as written would have stalled the increment **silently** — an instrument that looks like it is
working while producing nothing, which is this ADR family's recurring failure.

The primary instrument is therefore a **fleet sweep** (`scripts/research/adr-166-slot-sweep.ts`):
every workspace in the binding registry, both judgements, on a schedule — `musterd service install
--sweep`, a read-only `StartInterval` LaunchAgent, every 5 minutes. **The cadence is derived, not
chosen.** A `demoted` case persists for at least `LOCAL_SESSION_LIVE_MS` (10 minutes) from the last
touch of the slot's transcript, so any interval ≤10 minutes cannot miss an instance; sampling slower
would leave "target: zero" unfalsifiable rather than merely unproven. A cloud routine — the shape
`docs/design/research-radar-plan.md` chose for its own sweep, to survive the machine being off —
cannot be used here: this sweep reads the local binding registry and the local harness transcripts,
so it must run where they are. It is a **proxy and is
labelled as one** — it measures how often the slot is wrong _at rest_, while the cost lands at wake
time. The proxy is tight because the guard calls exactly this function, but it cannot say whether
wakes _correlate_ with phantoms, so it bounds the error rate the guard is exposed to, not the rate at
which it is bitten. Wake-decision counts remain the confirming dataset, read over months.

First corrected sweep: **23 judgeable, 3 disagreed, 2 in the dangerous direction** — and on
inspection the slot is wrong in all three, including a case it cannot see at all.

**A third pattern, found by the sweep — corrected 2026-07-27 after verification.** This section
first blamed `captureSession`'s `MUSTERD_BINDING` preference, materialized into the shared MCP entry
(ADR 165). **That cause is wrong, twice over:** izzo's sweep measured that the shared entry carries
no `MUSTERD_BINDING`, and inspecting both observed instances shows the same, simpler mechanism —
each session ran in a nested worktree that had **no** `.musterd/binding.json` **at capture time** (one
created its binding 86 seconds later; the other never had one), so `findWorkspaceDir`'s walk-up
correctly continued to the parent workspace and captured there. Not a bug: the walk-up doing what it
is specified to do for a workspace-less directory. It is consistent, too — enumeration attributes
transcripts through the same `findWorkspaceDir` walk-up, so both judgements agree on where such a
session belongs. The residual oddity (a parent slot describing a nested worktree's session) stops
mattering for enumerating harnesses once the slot no longer decides liveness (increment 2).

**Eval — dataset and baseline.** The dataset is every wake decision over a dogfood week joined to its
paired judgements. The **baseline** is measured, not assumed: across four live worktrees at one
instant, the slot was wrong **2 of 4** times, both in the dangerous direction (reporting no live
session for a workspace that had one).

1. _How often does the slot lie, on real wake decisions?_ Count `liveness_disagreed`. If it is near
   zero over a week, the two hand-caught cases were coincidence and increments 2–4 need re-arguing.
2. _Does it lie in the dangerous direction?_ Split disagreements by which side said `live`.
   Slot-says-not-live-but-enumeration-says-live is the money-losing case. Target for increment 2:
   **zero** such cases surviving the flip.
3. _Does enumeration ever demote a live seat?_ The inverse error, and the one that would make this
   worse than what it replaces. Target: **zero**; any instance blocks the flip.

**What a finding does.** A metric whose target is zero needs no dashboard — it needs an exception
that reaches someone. So: every run appends to `~/.musterd/research/adr-166-slot-sweep.jsonl`; a
clean run is **silent** (a line printed at zero is wallpaper within a week, and the exception stops
reading as one); a `demoted` case logs loudly and exits non-zero, so launchd's log and any wrapper
see a real failure rather than a quiet no-op; it then shows in `musterd report` (team and exec) until
it clears. Only a workspace demoted by **two consecutive runs** fires an OS notification. That gate
is affordable because demotion is **structural, not transient**: both judgements share one clock and
one 10-minute threshold, so a session that merely goes quiet mid-sweep makes *both* say not-live and
produces no disagreement at all. A real finding therefore repeats, and confirming costs one interval.

**Guardrail.** No workspace whose transcript is being written may be judged not-live. Regression
test: a workspace with a freshly-touched transcript reads `live` regardless of what the slot holds —
including when the slot holds an ended foreign capture, which is the `agents-stanley` shape exactly.

**Experiment.** Increment 1 **is** the experiment, and a real one: shadow mode is a paired within-run
comparison of two judgements against the same wake decisions, with the incumbent acting. It needs no
separate arm because both conditions are computed for every decision, and it risks nothing because
the challenger cannot act until it has evidence.

## Consequences

- Wake decisions stop being fooled by a foreign capture — the guard sees live sessions, and resume
  targets the session that actually exists rather than skipping to an expensive fresh spawn.
- `binding.session` survives as a fallback with a narrowed, honest meaning. The hook keeps writing
  it; nothing that can enumerate will read it.
- A harness without an enumerator keeps today's risk. That is a stated limit, not an oversight, and
  it is why the slot is not deleted here.
- One more optional method on `Harness`, one filesystem listing per judgement — the same order of
  cost as the `stat` it replaces.
- ADR 164's adapter ladder is unaffected: it already treats the binding as a hint, re-adopting rather
  than trusting a changed id.

## Related

- ADR 165 (izzo, PR #400) — the shared-slot shape and the empty-don't-partition remedy. This ADR answers its transfer test affirmatively, with
  the harness-specific limit noted above.
- [ADR 164](164-session-attested-presence.md) — recorded this as its explicit non-fix; its
  dormant-over-exit asymmetry is the reasoning reused here.
- [ADR 131](131-harness-residency-wake-ledger-host.md) §5 — where the capture and the wake ledger
  came from.
- [ADR 068](068-workspace-scoped-displacement.md) — why spawning beside a live session is not merely
  wasteful.
