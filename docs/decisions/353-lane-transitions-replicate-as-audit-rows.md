# 353 — lane transitions replicate: the `lane.*` audit row is the second kind on the sync wire

- Status: proposed — 2026-09-02. Authored by stanley on lane `01M1G2J80CQGX9H3MBQYKJ70HA`, the
  lane-replication slice of the ADR 325 federation build. Landed as #1185, stacked behind #1179 and
  #1182 (which gave every lane birth a `lane.opened` row) and behind #1181 (migration v57; this ADR's
  v58 must run after it).
- Date: 2026-09-02
- Builds on: [ADR 325](325-multi-machine-federation.md) (the residence rules, and "fold pulled
  events the way `goals.ts` folds"), [ADR 331](331-ordering-substrate.md) (`(origin_node,
  origin_seq)` and the one allocator per node), [ADR 335](335-sync-wire-format.md) (the wire is the
  envelope composed, never restated; §8 reserves the allocator for "a second kind"), [ADR 071](071-v0.3-p2-in-band-enforcement-and-audit.md)
  (the audit log this replicates a slice of)
- Design record: `docs/superpowers/specs/2026-09-01-lane-replication-design.md` — the four findings,
  the measurement, and §"The wire, decided", which this ADR makes the contract.
- Lane: `01M1G2J80CQGX9H3MBQYKJ70HA`

## Context

3b-ii (#1155) replicates `messages` between a hub and its joiners: one allocator per node stamps
each row, the push carries it as `SyncEvent = { envelope, origin_node, origin_seq, from_provenance }`,
the hub stages it in canonical order, and one fold — run by hub and joiner alike — applies it.

Lanes did not cross. The `[lane] …` announcement did, as a message, but it carries three fields of a
row that has fourteen (spec §Finding 1). The transition itself is the `lane.*` **audit** row:
increment 1 (#1071) made every lane edge leave one, and the slice's first three PRs closed the holes
that made it insufficient — the two silent releases (#1173), values on `lane.updated` (#1173), the
row written inside the lane write's transaction with the required append (#1178), and a birth
event carrying the whole declaration (#1179, #1182). As of #1182 a lane's whole life is in the
log, from 2026-09-02 forward, written in the transaction that made it true.

The measurement (spec §"The measurement") settled the design question the lane opened with: fold
the log rather than stamp and sync `lanes` rows. Folding 1,912 `lane.*` rows costs one millisecond
more than the table read it would replace; the projected state agrees with the table for every lane
that has any row. What remained was one sentence: the row cannot leave the machine.

## Problem

Ship the `lane.*` audit row over the existing sync wire, and apply it on the receiving side, without
giving `lanes` a second stamped-row sync path (which ADR 325 excluded as "row sync wearing an
event's clothes") and without breaking a single event a 3b-ii build has already staged.

## Decision

### 1. The `lane.*` audit row is the replicated event, and it draws from the node's one allocator

A `lane.*` row is stamped `(origin_node, origin_seq)` from `nodes.next_seq` at the moment the store
writes it, inside the lane write's transaction (`appendLaneEventRequired`). The allocator is the one
`insertMessage` uses. ADR 335 §8 reserved exactly this — "one allocator serves every replicated
kind, so the moment a second kind draws from it … a messages-derived head under-reports" — and the
push-side head already reads the allocator rather than `MAX(origin_seq) FROM messages`. A node's
sequence is therefore dense across both kinds and the hub's gap check is unchanged.

Migration v58 adds the pair to `audit` with `DEFAULT ''`/`0` and a unique index partial on
`origin_seq > 0`: every non-lane row, and every row older than the migration, reads as "not
replicated" and never collides. The partial index is the fold's idempotence key, the shape v54 gave
`idx_messages_origin`. **Only `lane.*` verbs are stamped.** The governance log does not replicate;
the slice replicates lane transitions, and the partial index is where that boundary is visible.

Every `lane.*` writer goes through the stamped, required append: the store's five verbs, both
departure releases, `lane.closed` and `lane.ready_for_review`. A lane row written through the plain
best-effort append would be a transition the origin holds and no peer ever sees — the hole this
slice exists to close — so there is no such path left.

### 2. The wire is a tagged pair; the message event is unchanged and its tag is optional

```ts
SyncEvent = SyncLaneEvent | SyncMessageEvent
SyncMessageEvent = { kind?: 'message', envelope, origin_node, origin_seq, from_provenance }  // as ADR 335
SyncLaneEvent    = { kind: 'lane', team, event: AuditEntry, origin_node, origin_seq }
```

`kind` is optional on the message event so that every event a 3b-ii build ever staged parses
unchanged: no re-staging, no epoch bump for the existing kind, and a joiner one build behind still
folds every message it is sent. The lane event composes `AuditEntrySchema` from the protocol package
rather than restating its fields, for the reason ADR 335 §1 gave the envelope: the receiver runs
exactly the validation the sender's own daemon ran. `event.action` stays the open string ADR 074
made it; the **fold**, not the wire, decides which verbs it can apply. `event.ts` travels — it is the
origin's clock, and the projected lane's timestamps are the origin's facts about when it moved.
`created_at` does not, as for messages.

The hub's ingest checks `team` against the authenticated node's team for both kinds, keys `sync_log`
on the audit row's ULID for the lane kind (the envelope's for a message), and stores the event
verbatim. The pull wire is the same pair with `hub_seq` beside it.

### 3. The push merges both kinds in origin order

`unpushed` reads messages and stamped audit rows for the node after the cursor, merges them on
`origin_seq`, and bounds the merged list — not each side first, which could ship seq 501 of one kind
ahead of seq 3 of the other. The cursor is a seq, and a seq is a seq whichever table holds it.

### 4. The fold holds the row and projects it, in one transaction, and blocks on what it cannot apply

The two disciplines of the message fold carry over unchanged: `nodes.next_seq` is never touched, and
the fold blocks rather than skips. Replay and the read-side gap check run across **both** kinds — a
head read from one table alone under-reports and trips the gap check on a legitimate sequence.

A lane event that passes is inserted into local `audit` with its stamp verbatim, and then
**projected into `lanes`** in the same transaction, each verb doing to our row what the store did to
the origin's: `lane.opened` inserts from the declaration; `lane.claimed` sets the owner and
`claimed_at`; `lane.released` clears the owner and moves the lane to `open`; `lane.state_changed`
moves the state; `lane.updated` applies each `changes[field].to`; `lane.ready_for_review` moves to
`awaiting_acceptance`; `lane.closed` sets the terminal state and `resolved_at`. The two review verbs
are held and project nothing.

Two new stops, both the `unknown_act` shape (block at the event, prefix committed, retried each
tick, logged at error):

- `unknown_lane_event` — a verb this build cannot project. Upgrade this daemon.
- `lane_unborn` — a transition for a lane this daemon never saw born: the origin's lane predates
  `lane.opened` (2026-09-02), or the log has a hole. Applying it would mint a row with no title. The
  projection runs **before** the audit insert so an unborn stop leaves no row behind that would
  advance the held head past an event never applied.

### 5. `lanes` on a peer is a materialised projection with exactly one foreign writer

`openLane` remains the sole *local* insert path; the fold is the sole *foreign* one, reviewed in one
file and run by hub and joiner alike — the posture 3b-ii gave `messages`. No `lanes` row is stamped
and no `lanes` row is synced; a peer reaches the same table by the same transitions the origin took.
Every existing reader of `lanes` keeps working with no change. The measurement showed a read-time
projection is affordable; this design does not need one, because the fold applies each event once,
on arrival.

### 6. Both sides fold, symmetrically; ownership is not yet arbitrated

A joiner projects a hub-side claim and the hub projects a joiner's. Nothing refuses the second of two
claims for one lane — that is 3c (hub-authoritative claim CAS), which now has the substrate it was
missing. Until 3c, a joiner projecting a claim from a stale log is exactly as wrong as it is today,
when it sees nothing at all.

## Alternatives considered

- **Stamp and sync `lanes` rows (the lane's opening description; spec option B).** Row sync wearing an
  event's clothes — the thing ADR 325 excluded — and a second stamped insert path into `lanes` with
  all of ADR 331 §Consequences' hazards, to reach a state the log can already express. Rejected on
  the measurement: the log expresses the state, and the cost of deriving it is small.
- **Widen the `[lane]` message's `meta` to carry the whole transition.** The notes are emitted by
  the handler after the write commits, through the failure-swallowing path, and the incident, seed
  and sweep writers emit none — the same gap hole 3 closed for the audit row, reopened one layer up.
  Rejected.
- **Replicate all of `audit`.** ADR 331 §5 lists it as a later slice; it is large, mostly local
  governance evidence, and would need its own bound. The partial index keeps the door open without
  walking through it.
- **A discriminated union with a required tag on both kinds.** Would refuse every event already
  staged under 3b-ii until re-staged, for no gain. The optional tag on the message kind is the whole
  compatibility story.
- **Read-time projection of `lanes` from `audit` everywhere (spec option A as first written).**
  Rewrites every reader of `lanes` for a benefit the materialised fold already delivers. Kept as the
  fallback if the fold's single-writer property is ever found wanting.

## Consequences

- An audit failure on a lane transition now fails the transition with a 500, on every path including
  the close and the ready-for-review edge. That is the point: a lane that moved with no record is the
  failure this slice exists to prevent, and `messages` has paid the same price since v1.
- **Second-machine precondition, stated plainly:** a joiner enrolling today folds a log whose lanes
  older than 2026-09-02 have no birth. A transition for such a lane stops the fold as `lane_unborn`
  until the origin's history is reconciled by hand. The deployment topology doc says so.
- v58 must land after v57 (#1181). `runMigrations` is a high-water mark; a lower number arriving
  later never runs (#1174, wiki: migration high-water mark).
- `sync_log.id` now holds audit ULIDs beside envelope ids. Both are unique per origin; the
  `SyncDuplicateIdError` classification covers both.
- 3c can now be built: the hub holds every joiner's claims in its own `audit` and `lanes`.

## Observability & Evaluation

- **Traces.** Every `lane.*` audit row now carries `(origin_node, origin_seq)`; a row with
  `origin_seq = 0` after this ADR lands is a lane transition that bypassed the stamped append, which
  is the defect. On a peer, a folded lane row has a foreign `origin_node` and the same `id` as the
  origin's. The fold's two new stops log `sync_fold_unknown_lane_event` and `sync_fold_lane_unborn`
  at error, per ADR 335 §7 — a stop must be distinguishable from being offline.
- **Eval.** Dataset: the live corpus at schema 55 (792 lanes, 1,912 `lane.*` rows, measured
  2026-09-02, spec §"The measurement"). Baseline: projected state agrees with the table for 620 of
  620 lanes that have any row; owner agrees for 508 of 620, every disagreement a pre-verb claim.
  Direct assertions: the two-daemon falsifier (`sync/lanes.test.ts` — a lane opened and claimed on
  the joiner is visible on the hub with owner and scope intact; edit, move, release follow in
  order; a replay applies nothing; the joiner's allocator never moves), `fold.test.ts` "the lane
  kind" (birth projected with the stamp held; both stops commit the prefix and leave nothing
  behind; one dense sequence across kinds), `db.test.ts` v58 (unstamped rows never collide; two
  stamped rows on one pair are refused).
- **Experiment.** Pre-registered prediction: once a second machine enrolls, `SELECT COUNT(*) FROM
  lanes` on hub and joiner agree for every lane born after 2026-09-02, and the only `lane_unborn`
  stops name lanes older than that date. Falsify: a `lane_unborn` stop for a lane whose
  `lane.opened` row exists on the origin, or a lane visible on one machine and absent on the other
  with no stop logged — either means the fold skipped rather than blocked.
- **What would overturn this.** A corpus where the fold's per-event projection falls measurably
  behind the origin (the read-time projection is the fallback), or a second foreign writer into
  `lanes` appearing anywhere but `sync/fold.ts` (`containment.test.ts` is the place to pin that).
