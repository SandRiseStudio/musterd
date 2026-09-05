# 384 — The presence kind never blocks the fold

- Status: accepted
- Date: 2026-09-04
- Supersedes (in part): [ADR 382](382-presence-for-a-seat-we-do-not-hold.md) — its decision was
  right and too narrow. It unblocked one unprojectable presence shape and left the other, which
  wedged the same joiner ninety minutes later.
- Relates to: ADR 325 (presence is local-only; transitions replicate as a summary), ADR 356
  (presence replication), ADR 365 (the ledger's carve-out — a row that projects into nothing can be
  held honestly), ADR 381 (the genesis watermark — the same question asked of lanes)
- Decided by: nick, 2026-09-04 ("go"), recorded by stanley
- Lane: `01M1NFHEKT3JA9H9470GZ31BWG`, found by the cloud-seat dogfood (`01KZAAS15M`)

## Context

ADR 382 stopped the fold blocking on presence for a seat this daemon does not hold. The joiner it
was written for advanced two events and stopped again, at `hub_seq 9659`:

```
sync_fold_presence_unborn  presence=01M1J3TV6C…  action=presence.reattested  hub_seq=9659
  "a re-attestation for a session this daemon never saw attach; retrying each tick"
```

The seat this time is `ryder` — a seat the joiner holds — and its attach was **not** missing from
the log. It sat at `hub_seq 9652`, seven events earlier, and the joiner had applied it. Measured on
the machine: one `audit` row for that session, zero `presence` rows, and `reap_offline` in its own
log. The joiner folded the attach, its own reaper swept the row minutes later, and the
re-attestation arrived hours behind because the machine is replaying a 22,000-event backlog at a
tick a minute. It was waiting for a row it had deleted itself.

That is not an edge case on a joiner catching up. It is the normal case, once per session, and
there were hundreds of sessions left in the backlog.

The census reading it falsifies is ADR 356's assumption that an unborn presence is a hole. On a
daemon that reaps, born-then-reaped and never-born are indistinguishable after the fact — and one
of them is routine.

## Problem

`presence_unborn` cannot tell "the attach never came" from "the attach came and I deleted it".
Decide what a presence event that cannot project should do, knowing the second case is ordinary.

## Decision

**No presence event blocks the fold, except one that a newer build wrote.**

1. **Unprojectable presence advances.** Neither shape stops the batch any more: a seat this roster
   does not hold (ADR 382's case) and a session with no row (this one). The audit row lands with
   its origin stamp, so the transition is kept as evidence; nothing is written to `presence`.

2. **The reason is that presence decides nothing on a peer.** ADR 325 keeps presence local-only and
   replicates transitions only as a summary. A presence row for a session this daemon does not hold
   paints no roster line and gates no claim, so blocking on one trades a fact worth nothing for a
   fold worth nothing. That is precisely the carve-out ADR 365 gave the ledger, applied to the kind
   it fits best.

3. **Nothing is invented from a partial fact.** A re-attestation carries model and surface, not the
   full facets an attach carries. Rebuilding the row from one would be a lie with a schema — the
   failure the unborn stop was written to prevent, and the reason the answer is "advance", not
   "upsert".

4. **`unknown_presence_event` survives.** A verb or surface this build cannot store means the
   *origin* runs a newer build. That is transient and an upgrade clears it, which is why
   `unknown_lane_event` and `unknown_record_event` block too. The stops that must go are the ones
   that can never clear.

### Rejected

- **Rebuild the row from the re-attestation.** See decision 3.
- **Exempt only re-attestations whose attach we can prove we reaped.** Nothing records that: the
  row is gone and the reaper writes no tombstone. Adding one to preserve a stop that guards nothing
  is a schema change to keep a wedge.
- **Stop reaping remote presence while a backlog drains.** Couples the reaper to sync state and
  makes a joiner show stale liveness for hours, to protect a fact that decides nothing.
- **Leave ADR 382 as it stands and treat this as a joiner-only nuisance.** It is the shape every
  new machine meets, once per session in the backlog. There is no version of "second machine" that
  does not hit it.

## Consequences

- A joiner replaying history is no longer stopped by presence at all. Given ADR 381 and ADR 382,
  this is the third and last of the fold's never-clears-by-itself stops to fall.
- A genuine hole in presence replication would now pass silently. Accepted, and cheap to accept:
  the fact it would have caught decides nothing here, and the audit trail still holds every
  transition. The kinds that decide something — messages, lanes, records, continuity — keep every
  stop they had.
- ADR 382's code and its test are subsumed rather than reverted: the seat check remains as the
  guard that keeps `projectPresenceEvent` from being called for a seat that has no member row.

## Observability & Evaluation

**Traces.** `sync_fold_presence_unborn` should disappear from every daemon's log;
`sync_fold_blocked` naming a presence seat went with ADR 382. The one presence stop left is
`unknown_presence_event`, which now means only what it says: this build is behind the peer's.
Falsify on two live daemons: fold an attach on the joiner, delete the row (or wait out the TTL),
then push the session's re-attestation — the cursor must cross it within a tick, with an `audit`
row and no `presence` row.

**Eval.** The claim is "a joiner drains a backlog without presence stopping it, and a fact that
decides something still stops it". Baseline, measured 2026-09-04: the Fly joiner stopped at 9,393
(ADR 381), then 9,657 (ADR 382), then 9,659 — three permanent wedges in one replay of one team's
history. After: the cursor reaches the head. The control is the untouched half — a message from an
unresolved seat still stops the fold (`sync/presence.test.ts` case 8), so "advance" did not quietly
become the rule for everything.

**Experiment.** None — no flag, no rollout. A single-machine team folds no foreign presence.

## Falsifiers

1. `sync/presence.test.ts`: a re-attestation whose row was folded and then deleted advances,
   carrying its `audit` row and inventing no `presence` row. Before this change it stopped the
   batch and applied nothing — the exact wedge measured at `hub_seq 9659`.
2. `sync/presence.test.ts` case 6, rewritten: a re-attestation for a session never seen advances,
   and a detached for the same ghost, staged behind it, applies too rather than queueing behind a
   stop that would never clear.
3. `sync/fold.test.ts`, the unit-level pair, likewise rewritten. Both predecessors asserted the old
   contract; the diff between them is the decision.

## Record note — the commit subjects name the wrong numbers

Two commit subjects from the session that landed this decision carry ADR numbers that a
parallel-branch collision later moved. The files are right; the git record misdirects:

- `2ffeeab2` says "ADR 382: a misreported model is not an observation" (#1292). That decision is
  [ADR 383](383-a-misreported-model-is-not-an-observation.md).
- `c73c5657` says "the presence kind never blocks the fold (ADR 383, superseding part of 382)"
  (#1297). That decision is this one, ADR 384.

A reader chasing "ADR 383" from the ADR 109 attribution trail lands on the model-attestation
decision, not the fold. Noted here rather than rewritten, since the commits are already on `main`.
Found by ryder at acceptance of `01M1NFHEKT`, 2026-09-04.
