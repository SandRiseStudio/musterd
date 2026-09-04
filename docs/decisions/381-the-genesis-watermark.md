# 381 — A joiner needs to know where the log's lane history begins

- Status: accepted
- Date: 2026-09-04
- Relates to: ADR 325 (one team, one authority; the sync model), ADR 331 (the ordering substrate —
  ULIDs allocated at the origin), ADR 365 (the ledger kind, and the block-don't-skip discipline),
  ADR 371 (the record kind; `seed_unborn` is the same shape), ADR 376 (which machine is the hub)
- Decided by: nick, 2026-09-04 ("lets go with your recommendation" — the watermark now, a
  snapshot at enrollment as its own increment), recorded by stanley
- Lane: `01M1NFHEKT3JA9H9470GZ31BWG`, found by the cloud-seat dogfood (`01KZAAS15M`)

## Context

The federation arc replicates lane transitions as `lane.*` audit rows (spec 2026-09-01), and the
fold projects them into the peer's `lanes`. It refuses a transition for a lane it never saw born:
applying one would mint a row with no title, so `lane_unborn` stops the batch and retries every
tick. That is block-don't-skip, and it is the right instinct — a fold that invents rows to keep
moving is a fold nobody can trust.

Lane replication began on 2026-09-02. Every lane born before that has no `lane.opened` anywhere in
the log, and never will. A transition for one is therefore an event that can never be applied and
can never be given up on, which is a wedge with extra steps.

Measured on the first real second machine (2026-09-04, a Fly VM enrolled at the laptop hub —
node `01M1NB5B7JATF1G9P4HQ02CWB9`):

- The joiner folded **9,393 of 22,496** hub events and then stopped, permanently, on
  `sync_fold_lane_unborn` for lane `01M1HJTF0M` — born 2026-09-02 17:31, minutes before
  `lane.opened` began replicating.
- On the hub, **92** lanes appear in the replicated log and **10** of them carry transitions with
  no birth. The first of those is where the joiner stopped.
- Nothing downstream of the fold could proceed: wakes are derived from folded messages, so the
  seat on that machine could not be woken at all.

Any second machine joining this team meets the same event and stops at the same place. The
federation work was complete and unusable at the same time.

## Problem

Tell a transition whose birth **will never arrive** from one whose birth is merely **not here
yet** — without loosening the discipline that makes the fold trustworthy.

## Decision

**The log declares where lane history begins in it, and anything older than that is pre-history.**

1. **The watermark is the smallest lane id the log holds a `lane.opened` for** (`laneGenesis`,
   `sync/log.ts`). Lane ids are ULIDs, allocated at the origin (ADR 331), so they sort by birth
   time. A lane older than the watermark provably has no birth in this log: the log contains none
   for anything older, by construction. It is not a hole; it is the edge of history.

2. **The hub ships it with every page.** `lane_genesis` joins `SyncPullResponse`, beside
   `hub_seq_high` and `nodes` — a fact about the log being read, not about either daemon. It
   defaults to `null` so an older hub's page still parses, and a `null` watermark restores the
   old behaviour exactly: block on every unborn lane.

3. **Older than the watermark advances; everything else still blocks.** The fold writes the audit
   row (so the transition stays in the trail, findable, with its origin stamp) and does **not**
   mint a `lanes` row — a row with no title would be worse than no row. A lane at or after the
   watermark with no birth still stops the batch, because there the birth may yet arrive from
   another origin, or the hole is real and worth finding.

4. **A joiner still replays the whole log.** Enrollment admits a machine; it does not draw a line
   under history (the same rule push already follows). Fixing *that* is snapshot-at-enrollment,
   pre-registered below, and deliberately not decided here.

### Rejected

- **Mint the row from the update.** The transition carries no title, scope or creator; the result
  is a lane the board shows with a blank name, which is the failure the `unborn` stop exists to
  prevent.
- **Skip every unborn lane.** This is the loosening. A birth that arrives out of order across two
  origins is normal and must block; a genuine hole must be findable. Both would become silent.
- **A date, or a schema-version cutover.** "Lane replication began on 2026-09-02" is true of this
  team and no other. A team that starts replicating tomorrow has a different edge, and a fresh
  team has none at all. The log's own contents answer it for every team without being told.
- **An operator escape hatch** (`node skip <hub_seq>`). It makes a person decide, every time, a
  thing the data already knows — and the first time it is used under pressure it will be used on a
  real hole.

## Consequences

- A joiner catches up on a team with pre-replication lanes. That is the whole point, and until it
  landed there was no second machine on this team at all.
- Those lanes do not exist on the joiner, and their transitions are visible only in `audit`. This
  is honest: the machine never learned what they were. They arrive whole on the joiner the first
  time someone edits them after a snapshot increment lands, or never, and the board on the hub is
  unaffected.
- The watermark is computed per page, from an index-free `MIN` over the lane births in `sync_log`.
  On this team's log that is 92 rows out of 22,496 and the query is not on the hot path of a fold;
  if a much larger log ever makes it matter, it is cacheable per team, invalidated by the next
  `lane.opened`.
- No schema change, no migration. One optional protocol field, defaulted.

## Observability & Evaluation

**Traces.** No new span. `sync_fold_lane_unborn` keeps its meaning and becomes rare — it now
reports only what it was written for: a hole, or a birth still in flight. Falsify on two live
daemons: a pre-history lane's transition advances the joiner's `sync_pull_cursor`, and no `lanes`
row appears for it while the `audit` row does.

**Eval.** The claim is "a joiner catches up on a team with history, and a hole still stops it".
Baseline, measured 2026-09-04 before this landed: the Fly joiner's cursor sat at 9,393 of 22,496
and did not move across repeated ticks; `musterd status` on the hub showed the seat offline with no
wake possible. After: the cursor reaches the head and the seat's first wake fires. The control is
the second test — a lane newer than the watermark with no birth must still block, and a run where
both tests pass is the only run that means anything, because skipping everything would pass the
first alone.

**Experiment.** None — no flag, no rollout. A single-machine team never pulls, and a team whose
lanes all replicated has a watermark older than every lane it holds, so the branch is unreachable
there.

## Falsifiers

In `sync/lanes.test.ts`, between two real daemons:

1. A transition for a lane older than the log's first `lane.opened` advances the fold: the
   watermark lane lands (impossible if the batch stopped), no `lanes` row is invented for the old
   one, and its `lane.updated` audit row is present. Fails without decision 3 — verified by
   disabling the branch, which reproduces the wedge.
2. A transition for a lane **newer** than the watermark with no birth still blocks: its
   `lane.updated` never reaches `audit`. Fails if the skip is applied to every unborn lane.

The pre-history lane in both tests is inserted straight into `lanes` with no audit row, because
that is the real shape — those lanes were never stamped by the allocator, so there is nothing to
push and no gap in the origin sequence. Deleting a stamped birth instead fabricates a gap, which
the hub rightly refuses; that is a different failure, and mistaking one for the other cost an hour
the first time.

## Pre-registered next increment

**Snapshot at enrollment.** The hub hands a joining machine the current lane state, and the joiner
pulls from the head instead of from zero. It ends the full-history replay (22,496 events before
this machine could see an act sent a minute earlier), and it gives pre-history lanes to the joiner
whole rather than as audit rows alone. It needs its own decisions — what else is in the snapshot,
how it interacts with the cursor, what happens when it is interrupted — and so its own ADR.
