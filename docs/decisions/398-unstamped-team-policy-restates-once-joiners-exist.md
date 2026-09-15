# 398 — Unstamped team policy restates once joiners exist

- Status: accepted
- Date: 2026-09-15
- Relates to: ADR 367 (the `policy` kind, and what a silent `setPolicy` still does not ship),
  ADR 185 (the stored doc is sparse), ADR 325 (policy is hub-authoritative), ADR 331
  (unstamped history is permanent for messages — policy is not a log, it is current state)
- Lane: `01M1T6DJ7J88WDZJXEY331VZ0V`

## Context

ADR 367 stamped new `policy.change` rows so a joiner's wake caps, cooldowns and `loops` are the
hub's after one sync tick. The census pinned the remaining seam in the same breath: silent
`setPolicy` still writes nothing to the wire. That seam is load-bearing — `setPolicy` is the
fold's own projector — and it is also the live hole.

Revive's hub armed `loops {review,dispatch,sweep}` before the kind existed. Those writes never
entered `sync_log`. The joiner's `teams.policy` stayed null. `claimWakeLeases` on that daemon
reads `teamPolicy.loops?.dispatch`, so every wake a seat living there could receive was a reply
doorbell under the 5-minute reply timeout — measured 2026-09-06 as cloud-seat finding 16, papered
over by arming the joiner's own policy by hand (and later in `seat.sh`). Lane `01M1T6DJ7J` stayed
open because ADR 367 shipped the kind and left pre-kind history unstamped.

Messages written before federation are permanently unstamped (ADR 331). That is correct for a
log: you cannot reconstruct what was never sequenced. Team policy is not a log. It is one sparse
doc, replace semantics, and the current value is sitting in `teams.policy` on the hub whether or
not anyone ever stamped it.

## Problem

A joiner that enrolled against a hub whose policy was last written unstamped — before ADR 367, or
via silent `setPolicy` — never learns the live doc. No later admin edit is required for the fork
to persist. The next `policy set` would heal it; nothing about ordinary operation produces that
edit. The cloud seat's workaround (set the same knobs on the joiner) is a second origin of a
value ADR 367 said has one.

## Decision

**The hub restates its current stored policy as one stamped `policy.change` the first time it has
joiners and no stamped `policy.change` exists.**

1. **One-shot, not a merge.** `restateUnstampedPolicy` no-ops when any `policy.change` already
   carries `origin_seq > 0`, and no-ops when the stored doc is empty. A later silent `setPolicy`
   stays the projector's seam — census.test.ts gap 1 still holds. Divergence after a stamp is an
   in-process caller bug, not a catch-up the sync tick may paper over.
2. **The event is the current stored sparse doc**, the ADR 367 shape, minted through
   `applyPolicyChange` so the row and the stamp are one transaction. Actor is the last unstamped
   `policy.change`'s actor if one exists, else the team's oldest living Member. The hub is still
   the only origin (ADR 367 decision 5); this is not a new writer, it is the hub restating a
   value it already holds.
3. **The loopback push is the call site.** Restatement runs at the start of `pushTeam` when this
   daemon is the hub, before `unpushed` is read, so the tick that notices joiners is the tick that
   ships the live doc. A hub that has joiners but has never minted a local node (policy written
   only via silent `setPolicy`) gets its node from `applyPolicyChange` here — we do not mint a
   node on a single-machine install just to discover there is nothing to push.

### Rejected

- **Re-stamp whenever stored diverges from the last stamped detail.** That would make silent
  `setPolicy` replicate, which is the projector primitive ADR 367 left silent on purpose.
- **Snapshot on enroll only.** Delta is already enrolled. A tick-time catch-up heals the live
  pair without a re-enroll; enroll-time is a subset of "hub has joiners".
- **Leave unstamped history, like messages (ADR 331).** Policy is current state. The fork is the
  thing ADR 367 existed to close, and leaving existing installs forked would be a hole in that
  decision, not a parallel to message pre-history.

## Consequences

- A hub whose `loops` were armed before ADR 367 ships that doc on the next sync tick after this
  lands. The joiner's `claimWakeLeases` then sees `dispatchLoopOn`, and a handoff to a seat on
  that machine can derive as a `work_order` (30-minute budget) rather than a reply doorbell.
- `seat.sh`'s `team policy --dispatch-loop on` on the joiner becomes redundant for enrollments
  that have pulled once after the hub restated. It stays as a floor until that tick has run; it
  is no longer the mechanism that makes work orders possible.
- The restatement is hub-minted with no admin `POST /policy`. That is allowed by ADR 367
  decision 5 (hub origin only) and does not bind any seat (decision 6 still applies to forwards).

## Observability & Evaluation

**Traces** — after the first loopback push on a hub that had no stamped `policy.change`, both
daemons hold a `policy.change` with `origin_seq > 0` whose `detail` equals the hub's stored doc.
Falsify: `sqlite3 ~/.musterd/musterd.db "select origin_seq, detail from audit where action='policy.change' order by ts desc limit 3"`
on hub and joiner — joiner empty after one sync tick, with hub `json_extract(policy,'$.loops')`
non-null, falsifies this ADR.

**Eval** — `getStoredPolicy` agreement after one round trip, for a hub whose only write was
silent `setPolicy` before any joiner pull. `sync/policy.test.ts` "written before the kind
existed" is the claim; census.test.ts gap 1 is the negative (a later silent write still does
not ship).

**Experiment** — none. The two-daemon falsifier is the whole claim. The live pair (revive hub +
delta's joiner) is the first production read: after this lands, `json_extract(policy,'$.loops')`
on the joiner should match the hub without a hand `team policy` on that machine.
