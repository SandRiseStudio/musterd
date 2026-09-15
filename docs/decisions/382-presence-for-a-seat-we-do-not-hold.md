# 382 — Presence for a seat this daemon does not hold advances, it does not wait

- Status: accepted
- Date: 2026-09-04
- Relates to: ADR 058 (roster identity replicates via git), ADR 063 (observers are runtime
  watchers, provisioned db-only), ADR 325 (presence is local-only; transitions are the summary),
  ADR 356 (presence replication), ADR 365 (the ledger's carve-out: a row that projects into nothing
  can be held honestly), ADR 381 (the genesis watermark — the same question, asked of lanes)
- Decided by: nick, 2026-09-04 ("lets go with your recommendation"), recorded by stanley
- Lane: `01M1NFHEKT3JA9H9470GZ31BWG` (continued), found by the cloud-seat dogfood (`01KZAAS15M`)

## Context

ADR 381 unwedged the first real joiner from a lane whose birth predated replication. It ran 261
events further and stopped again — permanently — at `hub_seq 9657`, on a `presence.attached` for the
seat `web-u6mvaj`:

```
sync_fold_blocked  seat=web-u6mvaj  hub_seq=9657
  "the fold names a seat this roster does not hold — not yet reconciled from git, or removed
   upstream; retrying each tick"
```

The message is accurate and the remedy it implies does not exist. `web-u6mvaj` is a web sign-in
seat: minted directly in the database, never written to `.musterd/seats/`, and roster identity
travels by git (ADR 058). No git pull can deliver it. Measured on the hub the same hour: **8**
`web-*` seats against **19** seat files, and the named seat is not in `members` at all any more —
the row is gone, so even asking the hub would not resolve it. Every web sign-in mints another.

Blocking is right when the missing thing can still arrive. A real agent seat added upstream shows
up on the next reconcile, and waiting is how the fold stays honest. It is wrong when the thing can
never arrive, and this is the second member of that family in one night.

## Problem

The fold treats every unresolved seat alike. Decide which kinds can honestly proceed without one.

## Decision

**A presence transition naming a seat this daemon does not hold advances, carrying its audit row.
Messages and lanes still block.**

1. **Presence for an unheld seat projects into nothing.** There is no member to hang a row on, so
   nothing is written to `presence` — it paints no roster line, gates no claim, and decides nothing
   here. ADR 365 already reasoned this way about the ledger: a row that projects into nothing is a
   row this daemon can still hold honestly, and blocking would wedge the fold on a fact that
   decides nothing. Presence is the same case, and ADR 325 already calls presence local-only with
   transitions replicated as a summary.

2. **The audit row still lands.** The transition is kept as evidence with its origin stamp, so this
   is a skip with a record rather than a hole this daemon opened in its own trail.

3. **The message rule is unchanged.** An inbox counts messages, so an unresolved seat there is a
   real gap worth finding, and git lag resolves on the next reconcile. Lanes keep the ADR 381 rule.

4. **This is the attach's half of a rule detach already followed.** A `presence.detached` for a
   session never seen was already a no-op that advances. The asymmetry was the bug.

### Rejected

- **Ship the set of db-only seats** so the joiner can tell "never" from "not yet". Exact, and a
  second protocol field plus a new hub responsibility, to decide something that decides nothing.
  Worth revisiting only if a case appears where the distinction changes an outcome.
- **Replicate db-only seats as members.** Reopens ADR 325's "the hub does not sync members — the
  repo does", to carry seats that exist for the length of a browser session.
- **Stop replicating presence for db-only seats at the origin.** Moves the filter to the writer,
  where it silently drops facts the origin legitimately holds, and leaves every already-staged
  event still wedging every joiner.

## Consequences

- A joiner is no longer stopped by a web sign-in on another machine. Given eight such seats and one
  per sign-in, this was not a rare shape.
- Presence rows for seats a daemon does not hold simply do not exist there, which is what the
  roster already shows. Nothing regresses for seats git does carry.
- If such a seat is later added to the roster, the skipped attach is not replayed. That is
  acceptable: an attach that old would have expired under the remote-presence TTL anyway, and the
  next transition resolves normally.
- `unresolved_seat` remains, for messages, meaning exactly what it says.

## Observability & Evaluation

**Traces.** No new span, and one fewer permanent error: `sync_fold_blocked` naming a presence seat
should disappear. Falsify on two live daemons: sign in to the web UI on the hub, then watch the
joiner's `sync_pull_cursor` cross that event's `hub_seq` within a tick, with an `audit` row for the
attach and no `presence` row.

**Eval.** The claim is "a joiner is not stopped by a seat git cannot carry, and a message from one
still stops it". Baseline, measured 2026-09-04: the Fly joiner sat at cursor 9,656 of 22,496 across
repeated ticks, `sync_fold_blocked` every 60s on `web-u6mvaj`. After: the cursor reaches the head.
The control is the second half of the test — a message from the same unheld seat must still block,
and a run where only the first half passes means the fold has stopped waiting for anything.

**Experiment.** None — no flag, no rollout. A single-machine team never folds foreign presence.

## Falsifiers

1. `sync/presence.test.ts` (two real daemons): a `presence.attached` for a seat on neither roster
   advances the fold, its `audit` row lands, and no `presence` row is invented — then a message
   from that same seat still stops the fold and never reaches `messages`. Before this change the
   first half failed with nothing applied.
2. `sync/fold.test.ts`: the unit-level version of the same pair. Its predecessor asserted the old
   contract (`stops as unresolved_seat, like a message`) and is rewritten here rather than deleted,
   because the diff between them is the decision.
