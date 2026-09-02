# Federation: presence replication — every machine sees every seat, and the hub's displacement rule sees them too

Owner stanley. Builds on 3c (`01M12FKHB0`, ADR 355) and the lane-replication slice (ADR 353).
Amends ADR 325 §Authority split residence 3 and is the slice ADR 355 §4 named as "the one that
closes it".

## Why this increment

ADR 355 §4 priced the hole: the hub arbitrates a claim against ITS presence table, so a seat
resident on a joiner has no presence at the hub and reads as **not live** — its lane is displaceable
by any seat, as an offline seat's is today. The ownership decision is linearizable; the liveness it
consults is not whole.

The narrow fix is a liveness bit per seat, reported upward. The brainstorm on 2026-09-02 decided
against the narrow fix, because presence under federation has three consumers and the narrow fix
serves one:

1. **Displacement.** The hub must know "is seat X live somewhere".
2. **Roster everywhere.** Every machine's `team_status` and `/live` must show every seat on every
   machine — surface, model, driver, workspace — or the hub sees a seat the joiner's own teammates
   cannot.
3. **History.** Presence must be queryable after the fact (who was live, where, on what model,
   when), the same way lane history is after ADR 353. The ADR 056 diversity conclusions and the wake
   rails both read it.

All three are served by one move: **presence transitions become the third replicated kind.**

## What ADR 325 said, and what changes

ADR 325 §Authority split, residence 3: "Local-only, never replicated: presence, wake leases,
footprint, schema meta. Presence is meaningful only on its host (ADR 058's live tier); each daemon
reports a *summary* of its local presence upward as ordinary events, which is how the roster view of
a remote machine is built."

The ADR was right that heartbeats are meaningless off their host, and it already named "ordinary
events" as the carrier. This spec takes the second sentence at its word and refines the first:

- **Heartbeats, the 45s reap, `held_until` grace, `conn_id`, and wake leases stay residence 3.**
  They are the *mechanism* of local liveness and never leave the machine.
- **Presence transitions — a session attaching, detaching, re-attesting — move to residence 2.**
  They are facts, append-only, written in the transaction that made them true, and they are exactly
  the "summary" ADR 325 asked for, at the granularity that makes history exact and cheap: one
  session is one `attached` row and one `detached` row, not two hundred heartbeat rows.
- **Node liveness is the one fact the transition log cannot carry**, and it rides on the surface the
  hub already speaks: the hub stamps `nodes.last_seen_at` on every authenticated contact and hands
  the table back on the pull.

Rejected during the brainstorm, with the reason:

- *Heartbeats as events.* Roughly 5,700 rows per seat per day, folded by every joiner, and a reader
  still has to compute "live" from row age.
- *Snapshots as events (a full summary every push tick).* History becomes "what the node said at
  60s intervals" and the fold has to diff snapshots to recover the transitions it wanted.
- *A liveness-only report to the hub, no log.* Serves consumer 1 and leaves 2 and 3 for a second
  design that would replace it. The 2026-09-02 session started here and moved off it.
- *A separate `remote_presence` table, unioned at read.* Every reader of the federated view has to
  be found and changed, and the ADR 042 kind-scoped single-active rule gets two tables to consult.

## Decision

### 1. Three `presence.*` verbs, written where the row changes

Each is an audit row appended through `appendReplicatedEvent` (the generalisation of
`appendLaneEventRequired`: same allocator, same SAVEPOINT, same "the number and the row are one
unit") inside the transaction that changes the `presence` row. `actor` and `target` are the seat
name. `detail.presence` is the presence row's ULID — the key every later verb and every reader joins
on.

| Verb | Emitted by | `detail` |
| --- | --- | --- |
| `presence.attached` | `attach`; `touchAmbientPresence` when it CREATES a row | `{presence, surface, provenance, workspace, driver, model, model_source, build, epoch}` |
| `presence.detached` | `detach` (`goodbye`); `reapStale` (`reaped`); `clearPresenceById` (`displaced`); `clearMemberPresence`, `clearOrphanPresence` (`cleared`) | `{presence, reason}` |
| `presence.reattested` | `reattestModel`, `reattestSurface`, when the value actually changed | `{presence, model, model_source, surface}` — the row's values after the change |

Not transitions, and not emitted:

- A heartbeat. An ambient touch that refreshes an existing row. `release` into grace — the session
  may come back; the reap that ends the grace is the detach.
- `occupancy.model_attested` stays exactly as it is. It is a ledger row about attestation (ADR 101,
  246); these are rows about the session. The two will often be written in the same transaction.
- **A node emits transitions only for rows it wrote.** `reapStale`, `clearMemberPresence` and the
  rest act on `node IS NULL` rows only (§2). A remote row is removed locally by its origin's
  `detached` folding in, or by the local reaper when the origin's node goes stale — and that local
  removal emits nothing, because this machine did not end that session and must not say it did.

`wake_lease` does not travel. It is a token another process verifies against the lease file on its
own machine (ADR 354); off-host it is a string with no verifier.

### 2. The fold projects into `presence`, plus a `node` column

Migration v60 adds `node TEXT` to `presence` (null: local, the row a socket or an ambient touch
animates). Foreign presence rows are the third thing the fold writes, in the same transaction as the
audit row, with the same discipline as lanes: block, never skip.

- `presence.attached` → `INSERT INTO presence` with `id = detail.presence`, `member_id` resolved
  from the seat name (an unresolved seat is `unresolved_seat`, the message rule), `node =
  origin_node`, `surface`, `status = 'online'`, `conn_id = NULL`, `held_until = NULL`,
  `last_seen_at = event.ts`, `created_at = event.ts`, and the attested fields from `detail`.
  `wake_lease = NULL`. An `attached` whose presence id is already held is a replay and skips.
- `presence.detached` → `DELETE FROM presence WHERE id = detail.presence AND node = origin_node`.
  Deleting a row that is not there is not an error: the local reaper may have removed it first when
  the origin went quiet (§3), and the origin's detach arriving later is the same fact, later.
- `presence.reattested` → `UPDATE presence SET model, model_source, surface WHERE id AND node`. A
  missing row here IS a stop, `presence_unborn`: an update to a session this daemon never saw attach
  means a hole in the log or a session older than this migration on the origin, and applying it
  would fabricate nothing but skipping it would hide the hole.
- An unknown `presence.*` verb is `unknown_presence_event`: block, "upgrade this daemon", retried
  each tick.

The `presence` CHECK on `surface` is the migration-57 list. A `surface` the local build's CHECK
refuses is an `unknown_presence_event` for the same reason an unknown act is: the origin runs a
newer build.

**Single-active does not cross machines through the fold; residence does, at ingest.** Today a
fresh agent hello on machine A for seat X clears X's presence rows on A (ADR 042). After this slice
it clears X's *local* rows on A and emits `detached (cleared)` for each; it does not touch X's remote
rows, and B's row for X's session on B is B's to end.

What stops two machines from both attaching seat X is the seat→node binding #1195 / ADR 355 §5
enforced at the claim edge (`seat_nodes`, ADR 328 §4). This slice extends it to the presence kind
at the hub's ingest: a `presence.attached` whose `actor` is a seat **bound to another node** is
refused with `SyncOriginError` — the node is not entitled to speak for that seat — and one whose
seat is **unbound binds it** to the pushing node, "the first time N speaks for X" taken literally.
Refusal is a `403` on the push, so the pusher logs `sync_push_refused_residence` at ERROR with the
seat and the bound node (distinguishable from offline, ADR 335 §7) and retries each tick; the way
out is the admin unbind, the same as at the claim edge. Detached and reattested rows for a seat are
checked the same way — a node may not end or re-attest a session on a seat it does not hold.

This is push-level residence for ONE kind, the kind this slice creates. Messages and `lane.*` rows
still name any seat at ingest; that is the general increment ADR 355 §5 named, and it lands after
this one rather than inside it. A human seat that attaches on two machines meets the same
`bound_elsewhere` a human claiming on two machines meets, and the same release valve.

### 3. A remote row is live while its node is

Liveness has two definitions after this slice, and they live in one predicate, in one file, and
every reader uses it:

- a **local** row (`node IS NULL`) is live when `held_until IS NULL AND last_seen_at > now −
  presenceTimeoutMs` — unchanged;
- a **remote** row is live when its node's `nodes.last_seen_at > now − REMOTE_PRESENCE_TTL_MS`.

`REMOTE_PRESENCE_TTL_MS = PRESENCE_TIMEOUT_MS + 2 × SYNC_PUSH_INTERVAL_MS` (165s today): the
origin's own reap window, plus two chances to report. This is the explicit staleness tolerance ADR
325 §Consequences said the build must not rediscover (ryder, #1069). A seat on a machine that lost
power is displaceable in under three minutes; a seat on a machine that is merely between pushes is
not.

`hasLivePresence`, `listPresence`, `listLiveDrivers`, `countLivePresences`, `hasActivePresence`
(unchanged: `conn_id IS NOT NULL` is local by construction) and `reapStale` all read the predicate.
The reaper deletes a remote row whose node has gone stale, silently (§1).

**How a machine knows a node's `last_seen_at`.** The hub stamps `nodes.last_seen_at = now` on every
authenticated sync contact — push, pull, claim — in `authenticateNode`'s success path. The column
has existed since migration v47 and had no writer. The pull response gains
`nodes: [{ id, label, last_seen_at }]` for every node of the team, the hub's own row included with
`last_seen_at = now` (a hub answering a pull is alive by definition). The puller upserts each into
its local `nodes` — `id, team_id, label, last_seen_at` only, `next_seq` untouched and every
credential column left alone — inside the fold transaction, before the events. A joiner today has
no `nodes` row for a foreign node at all (messages carry `origin_node` without a foreign key); after
this slice it has one for every node it has ever heard of, which is also what the roster needs to
print a machine name beside a remote seat.

The hub's view of node liveness is exact. A joiner's view of a third node lags by one pull, and a
joiner's view of the hub is the hub's own stamp, so a joiner that cannot reach the hub sees every
remote seat age out together after the TTL — which is the right answer: it cannot know, and "not
live" is the conservative reading for every consumer but the roster, which shows the age.

### 4. The hub's displacement rule changes nothing

`arbitrateClaim` keeps calling `hasLivePresence(db, incumbent.id, presenceTimeoutMs)`. Its input got
whole. The ADR 355 §4 comment in `claim.ts` is updated to say so and nothing else in that file moves.
That is the entire 3c follow-through, and it is one line of diff on purpose.

### 5. Roster everywhere

`PresenceSchema` (protocol `member.ts`) gains `node: string | null` and `node_label: string | null`.
`listPresence` fills them from the `presence.node` join. `team_status`'s member line shows the
machine label after the surface for a remote row; `/live` shows it the same way. No other roster
change: the summary already carried surface, model, driver and workspace, so the wire in §1 is
sufficient by construction.

### 6. History

`presence.attached`, `presence.reattested` and `presence.detached` in `audit`, on every machine,
joined on `detail.presence`, are the record. A session's duration is one attach and one detach. A
seat's model over time is its attach plus its reattests. Nothing in this slice reads the history;
the slice makes it exist and replicate, which is the precondition every reader was missing.

### 7. What this does to the residence table

ADR 325's three residences hold. Row 2 gains "presence transitions"; row 3 keeps "presence
heartbeats, grace, wake leases" and gains the clarification that a summary IS the transition stream.
`deployment-topology.md` §Increments gets the row; the 3c row's trailing sentence ("presence
summaries are the next slice") is closed.

## The wire

`SyncPresenceEventSchema = { kind: 'presence', team, event: AuditEntry, origin_node, origin_seq }`
— the lane event's shape with a different tag, composing `AuditEntrySchema`. `SyncEventSchema`
becomes the three-way union; `syncEventId` / `syncEventTeam` learn the tag. `SyncPullResponseSchema`
gains `nodes`. The push (`unpushed`) already reads every stamped audit row by `origin_node`, so
`presence.*` rows ride the same query the moment they are stamped; `toSyncEvent` maps the action
prefix to the tag.

Feature epoch 18: a daemon at this epoch stores `presence.node` and folds the third kind. An older
hub receiving a `kind: 'presence'` event refuses the batch with 422 (schema), which the pusher logs
at ERROR as `sync_push_rejected` — the terminal shape, and the honest one: the hub must upgrade
first. An older joiner pulling from a newer hub stops on `unknown_lane_event`'s sibling for the
unknown kind. Hub before joiners, as every federation increment so far.

## Falsifiers

`packages/server/src/sync/presence.test.ts`, two daemons through one hub, the `claim.test.ts`
harness:

1. A seat attached on joiner A (a real `attach`) is live on the hub and on joiner B after one
   push+pull, with surface, model, driver and workspace intact, and `node` naming A.
2. A claim from joiner B against a lane that seat holds is refused `409` naming the holder — the
   ADR 355 §4 hole, closed.
3. After A stops contacting the hub for `REMOTE_PRESENCE_TTL_MS`, the same claim succeeds, and
   `listPresence` on the hub no longer lists the row. No `presence.detached` was written anywhere.
4. A `detach` on A removes the row on B on the next pull; B's audit holds the `detached` row with
   A's stamp; B wrote no row of its own.
5. A `reattestModel` on A changes `model` on B; a `reattestSurface` changes `surface`.
6. A `reattested` for a presence B never saw attach stops the fold with `presence_unborn` and
   advances nothing past it. A `detached` for one is applied as a no-op and the cursor advances.
7. A fresh agent hello for seat X on A clears X's local rows on A, emits `detached (cleared)` for
   each, and leaves X's row-from-B untouched on A. Both rows show on every roster.
9. Residence at ingest: after nick claims on the hub (bound to the hub's node), an `attached` for
   nick pushed by the joiner is refused `403` and the joiner's push cursor does not move; an
   `attached` for an unbound seat binds it to the joiner in `seat_nodes`; after an admin unbind the
   refused batch is accepted on the next push.
8. `store.test.ts` presence cases unchanged: a single daemon with no enrollment emits stamped
   `presence.*` rows that nobody pushes, exactly as `lane.*` rows are today.

## Out of scope, named

- Push-level residence for messages and `lane.*` (§2). The presence kind gets it here; the rest is
  the general increment ADR 355 §5 named.
- Hub arbitration of handoff, release and close (ADR 355 §1). Still their own increments.
- Any reader of the history (§6). `musterd report`, the diversity view, the wake rails: each reads
  it when it needs it.
- Wake leases across machines. Off-host they are unverifiable strings.

## Migration numbers

v60 is this slice (`presence.node`); v59 is `seat_nodes` (#1195, ADR 355 §5). Open PRs at the time of writing carry no migration; re-check
before merge, and land after any that appear (the high-water-mark rule, #1174).
