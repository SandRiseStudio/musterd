# 371 — The record kind, and the rest of the ledger: the insight substrate crosses the wire

- Status: accepted
- Date: 2026-09-03
- Lane: `01M1MJ61JYM0CZ7VQJXC2DA2FK` (residence-2 census gap 3, the last of three)
- Closes: residence-2 census gap 3 (`docs/wiki/federation-data-census.md` §Gaps, ranked)
- Relates to: ADR 325 (residence 2: facts that cross without deciding; residence 1: what the hub
  decides), ADR 365 (the ledger kind — the shape this widens, and §3's pinning rule this ADR has to
  re-check), ADR 366 (the continuity kind — the seat-fact residence rule), ADR 367 (the policy kind
  — the hub-mints-on-a-joiner's-behalf shape), ADR 335 §8 (one allocator, dense across kinds),
  ADR 360 (residence at ingest), ADR 361 (a wake runs where the seat is enrolled), ADR 266/271
  (incident convergence — the count this ADR moves to the hub), ADR 144 (tool-call telemetry),
  ADR 236 (the host-suspension ceiling), ADR 252 (the lease-capture join)

## Context

Five kinds cross the wire today: messages, `lane.*`, `presence.*`, `ledger` (ADR 365) and
`policy` (ADR 367), plus `continuity` (ADR 366). The residence-2 census re-measured at `6a6304a7`
lists what still does not, and ranks it third and last because none of it decides anything
important on arrival — it makes **the report, the seed thread and the incident pool one-machine
views**:

| table / rows | writer today | who reads it | what a second machine loses |
|---|---|---|---|
| `tool_call_stats` | `recordToolCalls` — local UPSERT, additive counters + MAX, hourly bucket | `deriveToolCallMetrics` → `musterd report` | every tool-usage number counts one machine |
| `mcp.surface_rendered` (audit, unstamped) | `recordSurfaceRender` via `appendAudit` | the same report's surface-weight block | a seat's attested surface weight is invisible off its host |
| `seed_thread_entries` | `appendThread` — plain INSERT, keyed to the daemon-private `seeds.id` and `members.id` | `toSeed` (every seed read) | a clarification, answer, brief or conclusion written on one machine is absent from the seed everywhere else |
| `incident_reports` | `recordBlockedReport` at route time, on whichever daemon received the `status_update` | the clustering count, `incidentReporters` (resolve fan-out), duplicate-reporter replies | two seats blocked on the hub and one on a joiner never reach a threshold of three anywhere; three on each open **two** `incident: <gate>` lanes |
| `residency.*` outside the wake economy: `enrolled`, `revoked`, `wake_leased`, `host_suspended`, `session_captured`, `session_ended`, `context_read` | `appendAudit`, unstamped | `hostAsleepMs` (ADR 236 ceiling), `firstWakeLeaseTs` (ceiling clock start), `leaseCapturedSession` (ADR 252) — plus the audit trail | the ledger holds `woke` and `wake_cost` from every machine (ADR 365) but the lease, the capture and the suspension those rows refer to only from one |

Three facts shape the design more than the census did.

**Not all of gap 3 is the same residence.** `tool_call_stats`, the seed thread and the residency
verbs are residence 2 exactly as ADR 325 defines it: facts a peer can hold without deciding anything.
`incident_reports` is not. The pool exists to be **counted** — `pool.length < cluster_threshold` is
the decision that opens a lane — and a count taken on one machine is the one thing this arc has
refused every time it met it (lane claims, ADR 355; policy, ADR 367). Replicating the rows and
letting every machine count them would open one incident lane per machine that crosses the
threshold, and the lanes would then replicate at each other. The count is residence 1.

**The fold's idempotence key already makes counters safe.** `foldBatch` skips any event whose
`(origin_node, origin_seq)` pair is held (Rule 2, `heldPair`) before it reaches a projector. An
additive UPSERT behind that rule is applied exactly once per origin event, so "at-least-once
delivery" costs `tool_call_stats` nothing — the census's fear of a fold-side SUM going wrong was the
fear of a re-delivered batch, and the ordering substrate (ADR 331) closed it before this ADR opened.

**Two of the keys the seed thread uses do not exist off-host.** `seeds.id` is a ULID minted by
`createSeedFromRelay` on each daemon that ingests the relay, and `members.id` is daemon-private by
ADR 058 (`id`/`token_hash` never leave the machine). The row cannot cross as written; the event
must carry `relay_id` and the member's **name**, and the fold must resolve both — the same shape the
continuity kind uses for seats, plus one for seeds.

And one thing ADR 365 asked the next seat to check before widening its set (§3, §4): every deciding
reader of a replicated ledger verb must be pinned to rows this machine minted. The three residency
readers above are deciders — `hostAsleepMs` feeds the ceiling that decides whether a wake is due —
and **none of them carries `MINTED_HERE`**. Widening the set without pinning them would make a
joiner's suspension lengthen the hub's ceiling: a decision crossing the wire wearing an insight's
tag.

## Decision

**A sixth kind, `record`, whose events project into an additive or append-only table and decide
nothing; the incident pool moves to the hub and its rows replicate back as records; the remaining
`residency.*` verbs and `mcp.surface_rendered` join the ledger set, with every deciding reader
pinned first.**

### 1. A sixth kind, `record`, in the lane event's shape under its own tag

`SyncRecordEventSchema` is `SyncLaneEventSchema` under `kind: 'record'`, drawn from the same
allocator (ADR 335 §8), so a node's sequence stays dense across six kinds and every gap check holds
unchanged. The push tags it by action prefix (`record.` → `record`) as it does the others; the fold
branches on the **tag**, never on the prefix (ADR 365 §1's reason: a reader that re-derived the kind
from the verb would be a second copy of the rule that shipped it).

The fold holds the row in `audit` with the origin's stamp verbatim and, in the same transaction,
projects it by verb — a verb it cannot project stops as `unknown_record_event`, retried each tick,
the block-don't-skip discipline every projecting kind follows. Three verbs:

| verb | writer (stamped, one transaction with the row) | detail | projection |
|---|---|---|---|
| `record.tool_calls` | `applyToolCalls` (`store/toolCalls.ts`) | `{ seat, role, bucket_start, events: ToolCallEvent[] }` | the same additive UPSERT `recordToolCalls` runs today, with the ORIGIN's `bucket_start` — the arrival hour on the origin, not here |
| `record.seed_thread` | `applySeedThread` (`store/seeds.ts`) | `{ entry_id, relay_id, kind, body, by, created_at }` | resolve the seed by `(team, relay_id)` and the member by name; INSERT with the origin's `entry_id` |
| `record.incident_report` | `applyIncidentReport` (`store/incidents.ts`), **hub only** (§2) | `{ report_id, gate, seat, sig, ref, message_id, lane_id, created_at }` | INSERT the row as the hub holds it; a later `lane_id` stamp arrives as its own event |

`recordToolCalls`, `appendThread` and the raw `INSERT INTO incident_reports` stay as they are: the
fold's projector primitives, deliberately silent — the shape ADR 367 set for `setPolicy` and ADR 366
kept for `saveMemory`. The census test pins that the raw primitive still ships nothing.

### 2. The incident pool is the hub's; a joiner's report reaches it on the act it rides

A `blocked_by` report is `meta` on a `status_update`, and messages already cross. So a joiner
**writes nothing** to `incident_reports` and runs no clustering: `handleBlockedReport` is skipped on
an enrolled joiner, and the hub runs it when the message **ingests** (`POST /sync/push`) exactly as
it runs it for a message posted directly to the hub. The pool, the count, the threshold, the
`openLane`, the duplicate-reporter reply and the opening announcements all happen on the hub, from
the hub's own policy (which, since ADR 367, is every machine's policy). The lane the hub opens
replicates as `lane.opened`; the announcements it composes are messages and replicate; the joiner's
reporters read them from their own inbox after one tick.

Every `incident_reports` row the hub writes is stamped as `record.incident_report`, so every joiner
holds a read-only mirror of the pool. That is what keeps `incidentReporters` — the resolve fan-out
that runs at route time on whichever daemon the `resolve` is posted to — correct on a joiner: it
reads a local mirror of a hub-decided fact, which is how every `lanes` read already works.

**A `record.incident_report` the hub did not mint is refused at ingest**, the ADR 367 rule for a
policy event: admissible only on the hub's own loopback push, a `SyncOriginError` (403) otherwise,
and the batch binds nothing. A joiner-stamped pool row is a second counter in the making, and the
only thing worse than a count taken on one machine is one taken on two. Refusing at the hub rather
than at every joiner's fold means no joiner needs to know which node is the hub — the hub never
stages the row, so it never reaches one. The reporter it names is exempt from residence binding for
the same reason the policy actor is: the seat lives on the joiner, and binding it to the hub for a
row the hub wrote on its behalf would strand it.

**An unreachable hub delays a report; it never loses one.** The act queues in the joiner's push
like every other message and is counted when it lands. This is the opposite of ADR 367's refusal,
on purpose: policy is a decision an admin is waiting on, and a stale answer is a wrong one; an
incident is a count over minutes, and a late row is still a row. A blocked seat whose hub is down
sees the same thing it sees today below threshold — nothing — and that is honest.

### 3. `record.seed_thread` resolves two names, and a seed not yet relayed here stops the fold

The event carries `relay_id` (the relay's stable key, `UNIQUE(team_id, relay_id)`) and `by` (the
member's name). The fold resolves the seed to its **local** `seeds.id` and the member to its
**local** `members.id`; the entry keeps the origin's `entry_id`, so both machines hold the same row
under the same key. A seed this daemon has not ingested from the relay yet stops as `seed_unborn`,
retried each tick — `startSeedsIngest` runs on every daemon unconditionally (`index.ts:181`), so the
seed is at most one relay poll away, and blocking is the `lane_unborn` discipline: a thread entry
with no seed to hang on would be a row nothing can find. An unknown member name is git lag,
`unresolved_seat`, as for every seat-fact kind.

**Seed lifecycle state does not cross with the entry.** A brief written on the joiner replicates;
the joiner's `UPDATE seeds SET state = 'briefed'` does not, because the census recorded lifecycle as
"partial — the relay, not the hub", and moving it is a residence-1 change (an explorer claim is
"exactly one holder") that this ADR names and leaves open — the same posture ADR 365 took on
team-wide wake caps. After this ADR a seed's thread is whole on every machine while its state is
still the state each daemon last moved it to. That is strictly more than before and honestly less
than done; the census row says so.

### 4. The remaining `residency.*` verbs and `mcp.surface_rendered` join the ledger set — after the pinning

`REPLICATED_LEDGER_VERBS` (`store/audit.ts`, ADR 365 §4) widens by `residency.enrolled`,
`residency.revoked`, `residency.wake_leased`, `residency.host_suspended`,
`residency.session_captured`, `residency.session_ended`, `residency.context_read` and
`mcp.surface_rendered`. The set is still consulted inside `appendAudit`, never at a call site, so no
writer opts in and none can silently fail to.

Before the widening, in the same change, the three deciding readers gain `MINTED_HERE`:
`hostAsleepMs` (a suspension is a fact about **this** host; folding a peer's into the ceiling would
make the hub believe it slept while a laptop's lid was shut), `firstWakeLeaseTs` (a lease is
host-scoped by construction, ADR 361 — the ceiling's clock starts on a lease this host issued) and
`leaseCapturedSession` (the join is by lease id, and lease ids are host-local; pinning costs nothing
and closes the door). Reporting readers stay unpinned, as ADR 365 §3 has it: the insight is
team-wide, the decision is machine-local. `deriveToolCallMetrics`'s surface-weight read is one of
those, and it now sees every machine's attestation.

### 5. Residence applies to seat records; the hub's own rows never pass ingest

`record.tool_calls` and `record.seed_thread` are seat facts, minted where the seat works, so the
ADR 360 ingest binding is the one messages and continuity get: a node may stamp them only for seats
resident on it, and a forged record from a second enrolled node is refused `bound_elsewhere` with
`kind: 'record'`. Neither needed an exemption. `record.incident_report` needs none either, for a
different reason: it is minted on the hub, and the hub does not ingest its own events — the origin
rule in §2 is the whole of its protection.

### Rejected

- **Widen the ledger set with everything and let the fold append.** Right for the residency verbs,
  wrong for the three tables: a ledger row projects into nothing, and `deriveToolCallMetrics`,
  `toSeed` and the clustering count read tables, not `audit`. The census said "a typed kind, not a
  filter widening" and it was right.
- **Three kinds instead of one.** A kind is a tag that tells the fold which projector to run; three
  projectors under one tag with a verb table is the lane kind's own shape (seven verbs, one tag).
  Three tags would grow both unions, the push chain and the stop union three times for one idea.
- **Replicate `incident_reports` as residence 2 and let each machine count.** One incident lane per
  machine past the threshold; the announcements race; `findOpenIncident` by title then finds
  whichever replicated first. The count is the decision, and a decision is the hub's (ADR 325).
- **Forward the report to the hub as an RPC (`POST /sync/incident`), the ADR 367 shape.** Refuse
  on unreachable hub, as policy does. But the report already crosses on the act it rides; a second
  channel for the same bytes is a second thing to keep in step, and "hub down → report refused"
  would turn a blocked seat's status update into a 5xx for a fact that tolerates lag.
- **Carry the local `seeds.id` and `members.id` on the seed-thread event.** Neither exists on the
  receiver. `relay_id` and the name are the only keys both machines share.
- **Drop `tool_call_stats` and derive tool usage from `audit` rows.** Would make it a pure ledger
  verb and remove a table. But the hourly aggregate exists because per-call rows at 18 tools × 3
  outcomes × every seat × every call are the volume ADR 144 chose the bucket to avoid, and the wire
  would carry them all.

## Consequences

- `musterd report` counts every machine's tool calls, bounces and surface weight. The seed thread is
  whole everywhere. An incident opens once, on the hub, when the team — not one machine — reaches the
  threshold, and resolve fan-out reaches reporters on every machine.
- The fold has a sixth kind and two new stop shapes: `unknown_record_event` and `seed_unborn`.
  `seed_unborn` should be transient (one relay poll); one that persists is a relay-ingest defect
  wearing a thread entry's shape. The hub-origin rule lives at ingest, not in the fold.
- `foldBatch` returns the ids of the messages it inserted, and the hub's pull fires the incident
  hook from that list — never from a re-scan of `messages`, which would re-fire it every tick.
- The audit log now holds seed-thread bodies (briefs, conclusions) and blocked-report signatures,
  daemon-side only, never git — the ADR 366 consequence, one table wider. A brief is bounded by its
  own schema; nothing new is unbounded.
- `handleBlockedReport` runs at ingest on the hub as well as at route time. On a single-daemon team
  nothing changes: the daemon is the hub, no message ingests, the route-time path is the only path.
- Three deciding residency readers are pinned; on a single-machine install every row still matches
  the `''`/local arm of `MINTED_HERE` exactly as before.
- Push volume grows by the tool-call batches (one event per adapter flush, ≤ one a minute per live
  seat), the seed thread (rare), the pool (rare) and the residency remainder. On the dogfood corpus
  the residency remainder is the largest of these and is the same order as the wake verbs ADR 365
  already ships.
- Census gap 3 closes; the census's `seeds` lifecycle row stays "partial", now with this ADR's §3
  as its pointer. The residence-2 census has no open gap after this.

## Observability & Evaluation

**Traces.** No new span. Two log lines to watch, both expected to be quiet: `sync_fold_seed_unborn`
(reported once per blocker like every stop; one that outlives two relay polls means relay ingest is
behind on that daemon), and the hub's `forbidden` refusal of a pushed `record.incident_report` (a
joiner minted a pool row — a build downstream of it counts on its own). The existing
`ledger_stamp_failed` now covers the widened set. Falsify on two live daemons: record a
tool call on the joiner, `musterd report` on the hub after a tick — the tool's `calls` must rise by
the batch; append a brief on the joiner, read the seed on the hub — the entry is there with the
same id; post a `blocked_by` from a joiner seat, `SELECT COUNT(*) FROM incident_reports` on the hub
rises by one and on the joiner rises by one **after** the hub's row folds back, never before.

**Eval.** Two halves, the second the one that licenses the first.

1. *The substrate is whole.* On a two-daemon team, `deriveToolCallMetrics.calls`, a seed's
   `thread.length`, and `incidentReporters(lane)` read the same on both daemons within one tick.
   Baseline, from the census at `6a6304a7`: none of the three had ever crossed; a joiner's tool
   calls read as zero on the hub, its briefs were absent, its blocked reports never counted.
2. *No decision crossed with it.* `awakeMsSince` on the hub is unchanged by a folded
   `residency.host_suspended` from the joiner; `firstWakeLeaseTs` is unchanged by a folded
   `wake_leased`; and no incident lane is ever opened on a joiner. A rise in the hub's asleep
   milliseconds after a joiner suspension, or two `incident: <gate>` lanes for one gate, is the
   direct falsifier of the residence claim.

Half 1 is tested on two in-process daemons (`sync/record.test.ts`), not witnessed on two machines —
this team runs one daemon today, the same caveat ADR 365 and 366 carry. Half 2's pinning assertion
runs on the real readers with folded rows and needs no second machine.

**Experiment.** None. No flag, no rollout: the kind is inert until a second machine exists; the
joiner-side skip in `handleBlockedReport` is conditioned on enrollment, which a single daemon never
has; and the pinning is a no-op on rows minted here.

## Falsifiers

Between two real daemons in `sync/record.test.ts`, plus the readers in `store/residency.test.ts`:

1. A tool-call batch recorded on the joiner is counted by the hub's `deriveToolCallMetrics` — same
   tool, `calls` up by the batch, under the origin's `bucket_start`. Fails without §1. Re-delivering
   the same pull batch does not count it twice. Fails if Rule 2 is ever bypassed for records.
2. A brief appended on the joiner appears in the hub's `toSeed(...).thread` with the same entry id
   and `by` naming the seat; appended before the hub has relay-ingested the seed, the fold stops
   `seed_unborn` and applies it on the tick after ingest. Fails without §3.
3. Three seats blocked on the same gate — two posting to the hub, one to the joiner — open exactly
   one `incident: <gate>` lane, on the hub, and `incidentReporters` lists all three on **both**
   daemons after one tick. Before this ADR: zero lanes. Fails without §2.
4. A `record.incident_report` pushed by any node but the hub is refused 403 at ingest, stages
   nothing and inserts nothing — both hand-built from a second enrolled node and stamped through the
   joiner's own writer. Fails without §2's origin rule.
5. A folded `residency.host_suspended` from the joiner leaves the hub's `awakeMsSince` exactly
   where it was; removing `MINTED_HERE` from `hostAsleepMs` makes this fail. Fails without §4.
6. The raw `recordToolCalls` / `appendThread` / pool INSERT still ship nothing (`census.test.ts`).
   Fails if a primitive grows a stamp.
