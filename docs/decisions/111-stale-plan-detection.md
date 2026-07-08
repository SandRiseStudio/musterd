# 111 — Stale-plan detection: goal epochs + dependency-targeted invalidation (ADR 088 increment 3)

- Status: proposed — freezes increment 3 of the interrupt-line arc; implemented on `feat/stale-plan-detection`
- Date: 2026-07-08

## Context

[ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) built the interrupt line (increment 1) and
[ADR 103](103-steer-challenge-defer-acts.md) gave it a steering vocabulary (increment 2: `steer` /
`challenge` / `defer`). Together they shrink the window in which a busy agent is deaf to a change of
direction — from its next task boundary (minutes) to its next tool call (seconds).

They do not close it. The design arc
([interrupt-line-mid-loop-reachability.md](../design/interrupt-line-mid-loop-reachability.md) §5) was
explicit that interrupts shrink the deaf window but never close it: a model **mid-generation** is
unreachable, a **10-minute build** is one long tool call with no boundary inside it, and an
**approval-parked** agent stays [ADR 053](053-inbox-reaches-blocked-agent.md)'s problem. When the
interrupt misses, work proceeds against a superseded plan and the result is rework — the P3 dogfood put
that at ~37% of code produced, of which a single dependency-revert was 53% (one Lane built against an
assumption another Lane had already invalidated).

This ADR freezes **increment 3**: the semantic backstop that makes stale work **detectable** even when
no interrupt fired. It also gives `defer` the teeth ADR 103 deliberately withheld — that ADR shipped
`defer` as "the vocabulary and the signal … automatic re-sequencing of `nextGoal` on receipt (and the
goal-epoch bump a `steer`/`defer` implies) is increment 3's semantic layer," and named the seam
honestly: _"`defer` is a signal, not yet an actuator."_ This is where it becomes one.

## Problem

Catch work built against a superseded plan when the interrupt line couldn't reach the builder — and make
`defer` actually move the plan — **without new stored execution state** (the ADR 048 maxim: _record
facts, read meaning out of the durable record, never assert it into config; execution state is always
derived_), without a wire-version bump, and without turning targeted invalidation into a broadcast that
re-imports the noise the interrupt line was built to avoid.

Three sub-decisions:

1. **Where does the plan epoch live** — a stored monotonic counter, or a derivation?
2. **What does `defer` mutate**, given a Goal is a message-derived projection, not a table?
3. **Who gets told**, and how, when a Goal's epoch moves under live work?

## Decision

### 1. The Goal epoch is derived, never stored

A Goal already carries no stored status — status is a projection over the Lanes joined to it
([ADR 084](084-lanes-join-the-plan.md)), and the Goal itself is the latest `message`-to-`@team` carrying
`meta.goal` ([ADR 048](048-plan-goal-work-item-model.md)). The **epoch** joins that same derived floor:

> A Goal's **epoch** is the count of direction-changing acts that have landed on it — every `defer`
> naming it, and every `steer` that names it via an (additive, optional) `meta.goal_id`.

`0` means nobody has steered or deferred the Goal since it was declared. This is a read-side projection
over the append-only log, the exact posture of derived Goal status and of the `steer`-supersession
collapse ADR 103 put in `pendingInterrupts` — no `epoch` column, no write-path side-effect, no
migration (the v14 widening of `messages.act` already admits `defer`/`steer` rows). It rides what
exists. The systems analogy the design names is **bounded staleness** from async distributed training:
versioned parameters with a staleness tolerance, work within N epochs proceeds, beyond N warns.

`GoalSchema` gains a derived `epoch: number` alongside `status`; `listGoals` folds it out of the log.

### 2. `defer` actuates by folding into the Goal derivation, not by mutating a row

Because a Goal's `wave` is *whatever the latest signal in the log says it is*, `defer` needs no new write
path to re-sequence it. `listGoals` treats a Goal's declared base `wave` and every subsequent `defer`
naming it as **wave assertions**; the newest by `ts` wins (a `defer` with a numeric `meta.wave` reorders;
absent or `"later"` sends the Goal to the back). `nextGoal` reads the effective `wave`, so the plan
actually re-sequences — the same "latest declaration wins" rule ADR 048 already applied to Goal
re-declaration, now extended to the `defer` verb. A later re-declaration still overrides an earlier
`defer` (newest signal wins in both directions), and a re-declaration never erases accrued epoch history.

This is the actuation ADR 103 stubbed: after this increment, a `defer` is not just an auditable signal a
human acts on — it moves `next`.

### 3. Two owner-directed staleness signals, routed by the dependency directory

When a Goal's epoch advances under live work, exactly the affected Lane owners are told — never the team.
Two new **warn-only** `LaneWarning` kinds join the two Phase-1 contention checks (ADR 083):

- **`stale_plan`** — a live, owned Lane whose **own** Goal advanced an epoch since the Lane was claimed.
  "The plan under this Lane moved; re-check direction."
- **`stale_dependency`** — a live, owned Lane building on **another** Lane whose Goal advanced since this
  Lane was claimed. The dependency's interface may have shifted.

A Lane's epoch-at-claim is derived (count the Goal's bumps at or before the Lane's `claimed_at`); a
current epoch above it is staleness. This is **directory-based cache coherence**, the framing design §5.2
names: broadcast ("snooping") invalidation doesn't scale, so you track who holds what and invalidate only
them — the `goal_id` join and the `depends_on` edge **are** the directory entries. It stays
warn-never-block, watcher-not-gatekeeper, consistent with the lanes doctrine. The P3 dependency-revert
(53% of that session's waste) is precisely a `stale_dependency` miss — the case this closes.

### 4. Delivery rides the existing lane-warning channels — no new machinery

- **Push (the teeth):** a `defer`/`steer` naming a Goal, on the message send path, computes the Lanes it
  just made stale (scoped to that Goal) and directed-wakes their owners through the same
  `deliverLaneWarnings` helper contention warnings already use — the affected owner gets one targeted
  `[lane]` act in their inbox, which `team_inbox_check` and the interrupt line surface. Best-effort; the
  send always succeeds first.
- **Pull:** the board (`GET /lanes` / `musterd lanes`) annotates the current stale set live, intersected
  with the filtered view, so `?mine=1` / `?goal=` carry only their own flags.
- **Legibility:** `musterd goal` / `team_goals` show `epoch:N` once a Goal has moved (quiet at `0`), and
  the composed warning line names the moved Goal.

No new route, no new table, no SPEC bump — three additive derivations (epoch, the two staleness kinds),
one send-path branch, one board merge, and the `LaneWarning` enum grows by two.

## Consequences

- **`defer` has teeth.** It re-sequences `next` and flags the Lanes left building against the older plan.
  The honest seam ADR 103 named ("a signal, not yet an actuator") is closed; the vocabulary is now a
  mechanism.
- **Staleness is detectable when the interrupt missed.** A mid-generation / long-command /
  approval-parked agent that never saw the `steer` still finds a `stale_plan` wake in its inbox and a
  flag on its board the next time it looks — the backstop the deaf window needed.
- **Targeted, not broadcast.** Only the owners of Lanes actually invalidated are woken; the directory
  (goal_id join + depends_on edges) keeps it an interrupt fabric, not a noise fabric.
- **Nothing stored, nothing to drift.** Epoch and staleness are projections over the log, like Goal
  status — the amprealize board-rot the Goal model was designed against stays impossible here. No
  migration.
- **A scarce new interrupt reason exists but stays scarce.** A `steer` that names a Goal is already
  interrupt-class (ADR 103); the staleness wakes it triggers are ordinary directed `[lane]` acts, which
  only pierce the interrupt line when urgent — so deep work is not thrashed by a plan reshuffle.

## Observability & Evaluation

**Traces** — the staleness wakes are ordinary directed acts on the increment-1/2 instrumentation (the
`musterd.tool.call` / `musterd.cli.command` spans, ADR 089); a `steer`/`defer` that names a Goal already
raises the `musterd.interrupt.check` counter path when urgent. No new emitter.

**Eval** — the arc's headline metric extends: beyond **steering latency** (ADR 103), increment 3 adds
**stale-work caught** — the count of `stale_plan`/`stale_dependency` wakes that precede a Lane's owner
changing course (re-claiming, abandoning, or re-scoping) versus the P3 baseline where the dependency-steer
went unseen for a full work cycle. _Dataset:_ the message + lane log (every wake and the follow-on lane
verb are persisted). The guard metric is unchanged from ADR 088 — the warning-disable rate: if targeted
invalidation is noisy enough that owners tune it out, precision is too low.

**Experiment** — the built-in A/B from ADR 088/103 gains a third arm: the same two-agent task with a
mid-task direction change delivered as a `defer` while the second agent is heads-down inside a long
command (interrupt provably missed), measuring whether the `stale_dependency` wake caught the rework the
free-text `message` and even the `steer` could not. A coordination-traces benchmark scenario (ADR 056).

## Honest edges

- **Epoch counts direction changes, not their magnitude.** A trivial re-order and a breaking re-scope
  both bump the epoch by one; the warning says "re-check", not "you are broken". That is deliberate —
  warn-never-block, the human/agent judges. A weighted or typed epoch is a later refinement if the
  disable-rate metric ever demands it.
- **`team_next` enrichment is deferred.** The orientation brief does not yet inline "your stale Lanes";
  the directed wake (inbox) and the board already carry the signal, so this is additive polish, not a
  gap in coverage — reserved to avoid a `NextBrief` schema change in this cut.
- **Claim time is the baseline.** A Lane opened-but-unclaimed has no owner to wake and no build to
  invalidate; staleness is measured from `claimed_at` (the moment an owner started building), falling
  back to `created_at`. An unowned open Lane is never stale.
