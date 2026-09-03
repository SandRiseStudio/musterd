# 356 — presence replication: `presence.*` is the third replicated kind, and the hub's displacement rule sees every machine's seats

- Status: accepted — 2026-09-03 (merged `94c788b5`, #1200; proposed 2026-09-02). Authored by stanley on lane `01M1HZRWBW63HRHNSC0KSQZQ9J`
  (Federation: presence replication), from the 2026-09-02 brainstorm with nick. Builds directly on
  #1195 / ADR 355 §5, which minted the seat→node binding this extends to the presence kind.
- Date: 2026-09-02
- Builds on: [ADR 325](325-multi-machine-federation.md) (§Authority split residence 3, amended
  here; §Consequences: "the claim CAS is exact; its policy input is not"),
  [ADR 353](353-lane-transitions-replicate-as-audit-rows.md) (the replicated-audit-row shape and
  the one allocator this reuses), [ADR 355](355-hub-arbitrates-a-joiners-claim.md) (§4, the hole
  this closes; §5, the residence binding this enforces at ingest),
  [ADR 335](335-sync-wire-format.md) (§7: every refusal distinguishable from offline),
  [ADR 328](328-machine-credential.md) (§4 seat→node residence)
- Lane: `01M1HZRWBW63HRHNSC0KSQZQ9J`
- Spec: `docs/superpowers/specs/2026-09-02-presence-replication-design.md`

## Context

ADR 355 §4 priced the hole and named the slice that closes it: the hub arbitrates a claim against
ITS presence table, so a seat resident on a joiner has no presence at the hub and reads as **not
live** — its lane is displaceable by any seat, as an offline seat's is today. The ownership decision
was linearizable; the liveness it consulted was not whole.

ADR 325 residence 3 said presence is "local-only, never replicated … each daemon reports a *summary*
of its local presence upward as ordinary events, which is how the roster view of a remote machine is
built." It was right that heartbeats are meaningless off their host, and it already named ordinary
events as the carrier. Nothing had built the summary.

## Problem

Presence under federation has three consumers and a liveness bit per seat, reported upward, serves
one of them:

1. **Displacement.** The hub must know "is seat X live somewhere".
2. **Roster everywhere.** Every machine's `team_status` and `/live` must show every seat on every
   machine — surface, model, driver, workspace — or the hub sees a seat the joiner's own teammates
   cannot.
3. **History.** Presence must be queryable after the fact (who was live, where, on what model,
   when), the way lane history is after ADR 353. The ADR 056 diversity conclusions and the wake
   rails both read it.

## Decision

All three are served by one move: **presence transitions become the third replicated kind.**

### 1. Three `presence.*` verbs, written where the row changes

`presence.attached`, `presence.detached` (`reason`: `goodbye` | `reaped` | `displaced` | `cleared`)
and `presence.reattested` are audit rows appended through `appendReplicatedEvent` — the
generalisation of `appendLaneEventRequired`: same `nodes.next_seq` allocator, same SAVEPOINT, the
number and the row one unit — inside the transaction that changes the `presence` row. `actor` and
`target` are the seat name; `detail.presence` is the row's ULID, the key every reader joins on.
`attached` carries the roster's facets (surface, provenance, workspace, driver, model, model_source,
build, epoch); `reattested` carries the values after the change.

Not transitions: a heartbeat, an ambient touch that refreshes a row, `release` into grace (the reap
that ends the grace is the detach). `occupancy.model_attested` is untouched — a ledger row about
attestation, not about the session. `wake_lease` never travels: off-host it is a string with no
verifier (ADR 354).

**A node emits transitions only for rows it wrote** (`presence.node IS NULL`). A remote row is
removed locally by its origin's `detached` folding in, or by the local reaper when the origin's node
goes stale — silently, because this machine did not end that session and must not say it did.

Presence rows are liveness, not work: the quiescence readers (`lastActionByActor`,
`quietestBusyMs`) exclude `presence.*`, or every seat would read busy the moment it connected.

### 2. The fold projects into `presence`, plus a `node` column

Migration v61 adds `presence.node` (null = local). The fold writes `presence` as the third thing it
writes, in the audit row's transaction, with the lane discipline — block, never skip:

- `attached` inserts with `id = detail.presence`, the seat resolved by name (`unresolved_seat`
  otherwise, the message rule), `node = origin_node`, `conn_id`/`held_until`/`wake_lease` NULL,
  `last_seen_at = created_at = event.ts`. A held id is a replay and skips.
- `detached` deletes `WHERE id AND node = origin`; a missing row is the same fact arriving after
  the stale-node sweep, applied as a no-op.
- `reattested` updates model, model_source, surface; a missing row stops as `presence_unborn`.
- An unknown verb, or a surface this build's CHECK cannot store, stops as
  `unknown_presence_event`: the origin runs a newer build.

**Residence at ingest.** The seat→node binding ADR 355 §5 enforces at the claim edge is enforced
for the presence kind at the hub's ingest: a `presence.*` event whose actor is bound to another node
refuses the batch whole (`403 bound_elsewhere`, the seat named; the pusher logs
`sync_push_refused_residence` at ERROR and its cursor stays), and one whose seat is unbound binds
it to the pushing node — "the first time N speaks for X" taken literally. Runs before the replay
check: the binding is a fact about who may speak, not which seq was stored. This is push-level
residence for ONE kind; messages and `lane.*` still name any seat at ingest, the general increment
ADR 355 §5 named. A human whose first touch is on the hub is bound there; the release valve is the
same admin unbind.

### 3. A remote row is live while its node is

One predicate, `LIVE_PRESENCE_SQL` in `store/presence.ts`, used by every reader (`hasLivePresence`,
`listPresence`, `listLiveDrivers`, `countLivePresences`): a local row by its own heartbeat within
`presenceTimeoutMs`; a remote row while its node's `nodes.last_seen_at` is within
`REMOTE_PRESENCE_TTL_MS = PRESENCE_TIMEOUT_MS + 2 × SYNC_PUSH_INTERVAL_MS` (165 s) — the origin's
reap window plus two chances to report. This is the staleness ADR 325 §Consequences said the build
must tolerate explicitly. A seat on a machine that lost power is displaceable in under three
minutes; a seat on a machine between pushes is not.

The hub stamps `nodes.last_seen_at` on every authenticated sync contact (push, pull, claim) and the
pull response carries `nodes[]` for the team, the hub's own row stamped now. The puller upserts
`id, team_id, label, last_seen_at` only — `next_seq` and the credential columns are never touched —
before the events, even on an empty page.

### 4. The hub's displacement rule changes nothing

`arbitrateClaim` keeps calling `hasLivePresence`. Its input got whole. That is the whole 3c
follow-through, and it is a comment's worth of diff on purpose.

### 5. Roster everywhere

`PresenceSchema` gains `node` and `node_label`; `listPresence` fills them from the join. The CLI
member line reads `codex @ laptop-b` for a remote row and is silent for a local one; `/live` shows
the same (miley's lane `01M1J2WM980MDK8HCEQDK96Z3X`).

### 6. History

The three verbs in `audit` on every machine, joined on `detail.presence`, are the record. Nothing
in this slice reads it; the slice makes it exist and replicate.

### 7. The wire and the epoch

`SyncPresenceEventSchema` is the lane event's shape under `kind: 'presence'`; `SyncEventSchema` and
`SyncPullEventSchema` are three-way unions; `SyncPullResponseSchema.nodes` defaults to empty so an
older hub's page parses (every remote row then reads not-live, the conservative answer). Feature
epoch 18. An older hub refuses a `kind: 'presence'` push (422, `sync_push_rejected`); an older
joiner stops on the unknown kind. Hub before joiners.

## Alternatives considered

- **Heartbeats as events.** ~5,700 rows per seat per day, folded by every joiner, and a reader still
  computes "live" from row age.
- **Snapshots as events (a full summary every push tick).** History becomes "what the node said at
  60 s intervals" and the fold diffs snapshots to recover the transitions it wanted.
- **A liveness-only report to the hub, no log.** Serves consumer 1 and leaves 2 and 3 for a second
  design that would replace it. The 2026-09-02 session started here and moved off it.
- **A separate `remote_presence` table, unioned at read.** Every reader of the federated view has
  to be found and changed, and the ADR 042 kind-scoped single-active rule gets two tables to consult.
- **Residence checked but not minted at ingest.** Would leave an unbound seat attachable from two
  machines until one of them claimed; the binding exists to answer "who may speak", and speaking
  first is the honest first writer.

## Consequences

- ADR 325 residence 3 is amended: presence *transitions* are residence 2; heartbeats, grace,
  `conn_id` and wake leases stay residence 3.
- Every attach on any machine is an audit row on every machine. On a single-daemon install the
  rows exist and are pushed by nobody, exactly as `lane.*` rows are.
- On a single-machine install every seat is bound to the local node at its first attach after
  this lands (was: first self-claim, ADR 355 §5). Nothing changes in effect until a second machine
  enrolls.
- A joiner that cannot reach the hub sees every remote seat age out together after the TTL — it
  cannot know, and not-live is the conservative reading.
- Protocol: `SyncPresenceEventSchema`, `SyncPullResponseSchema.nodes`, `PresenceSchema.node` /
  `node_label`, epoch 18. Migration v61 (v60 is dolly's #1197, ADR 357; both open 2026-09-02, high-water-mark rule #1174). Three new log lines: `sync_push_refused_residence`,
  `sync_fold_unknown_event` (also now covers `unknown_lane_event`, which was never reported),
  `sync_fold_presence_unborn` (and `sync_fold_lane_unborn`, likewise).

## Observability & Evaluation

- **Traces.** A remote seat on a roster is a `presence` row with `node IS NOT NULL`. A refused
  attach is `sync_push_refused_residence` on the joiner and `seat.bound_elsewhere`-shaped 403 on the
  wire. A `presence.detached` row whose `origin_node` is not the node that wrote the matching
  `attached` is the defect §1 exists to make impossible.
- **Eval.** Dataset: `packages/server/src/sync/presence.test.ts`, seven two-daemon cases (spec
  §Falsifiers 1–7), plus the store cases for the local emitters and the node-aware predicate, the
  push cases for residence at ingest, and the fold cases for projection and the two new stops. All
  red before this increment where the code path existed, green after.
- **Experiment.** Pre-registered prediction: after a second machine enrolls on the dogfood team,
  every seat live on either machine shows on both rosters within one push+pull interval, and no
  lane held by a live remote seat is ever displaced. Falsify: a roster missing a seat live
  elsewhere for longer than `SYNC_PUSH_INTERVAL_MS + SYNC_PULL_INTERVAL_MS`, or a `lane.claimed`
  row displacing a seat whose `attached` predates it with no `detached` between.
- **What would overturn this.** A measured need for sub-TTL displacement of a partitioned machine's
  seats, or a fold cost from `presence.*` volume that a joiner cannot keep up with — either would
  revisit the TTL or the granularity, in a new ADR.
