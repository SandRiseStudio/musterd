# 453 — trace rows reach the hub on their own channel, not the coordination log

- Status: proposed — 2026-09-25
- Date: 2026-09-25
- Lane: `01M3DG52YVZ90GBGD2QJGXAX49` (goal `research-corpus`; ADR 445 increment 3b)
- Supersedes: [ADR 445](445-agent-traces-captured-local-first.md) §3, one clause only: that
  structural trace columns "replicate under ADR 371's `record` kind". Everything else in §3 stands:
  the separate `trace.db`, the two body classes, the rule that content never leaves the machine, and
  the `dataset:export` clause (built in increment 3a).
- Builds on: [ADR 325](325-multi-machine-federation.md) / [ADR 331](331-ordering-substrate.md) (the sync
  substrate: enrollment, `msnode_` machine credentials, the push loop), [ADR 360](360-push-level-residence.md)
  (a node speaks only for seats bound to it), [ADR 371](371-the-record-kind-and-the-rest-of-the-ledger.md)
  (the `record` kind this ADR declines to use for traces), [ADR 184](184-dataset-consent-and-redaction.md)
  §2 (what "structural" means).

## Context

ADR 445 put agent traces in `trace.db`, a file separate from `musterd.db`, for a stated reason:
per-call rows outgrow the coordination store within weeks, and the daemon wedged twice on
2026-09-24 in synchronous SQLite work on `musterd.db`. The same section then said the structural
columns replicate under ADR 371's `record` kind, which is a coordination-log mechanism. Increment 3
was split on 2026-09-25 (nick) when the two sentences were measured against each other, and this
ADR settles the second one.

Measured on the dogfood hub, 2026-09-25:

| quantity | value | falsify |
| --- | --- | --- |
| trace rows ingested | 5,834 in 5.24 h, about 26.7k a day | `SELECT count(*), min(ts), max(ts) FROM trace_events` on `~/.musterd/trace.db` |
| structural bytes per row | about 290 B (fixed columns + `detail`) | `avg(length(detail))` + column widths |
| whole `sync_log` to date | 121,801 events, 59 MB of payload | `SELECT count(*), sum(length(payload)) FROM sync_log` |
| `record` events to date | 5,996, 2.75 MB | the same, grouped by `$.kind` |
| enrolled joiners on `revive` | 1 (`850e40a4499168`), with seats `nick` and `delta` bound to it | `nodes` ⋈ `seat_nodes` |
| `revive` seats bound only to the hub | 15 agent, 8 human | the same join |

How a `record` event lands: the origin writes it to `audit` (ADR 371 §1) and stages it in its own
`sync_log`. The hub stages it again, and every joiner's fold writes it into its own `audit`. Under
§3 as written, the hub alone would add about 26.7k events a day to `sync_log` and `audit`, roughly
15 MB a day of the coordination store, and every joiner would pull and hold all of it. That is the
growth §3 created `trace.db` to avoid, and it would reach the machines that have no reader for it.

## Problem

A joiner's seats record their traces in the joiner's own `trace.db`: the tap posts to the seat's
own daemon, and content goes only to a loopback daemon. Nothing moves those rows to the hub. The
research corpus is captured on the hub (`corpus:snapshot`, `dataset:export`), so a joiner's seats
are missing from it, and the coverage eval (ADR 445 §Observability) undercounts the team.

Three requirements pull against each other:

1. The hub's corpus should hold every seat's structural rows, whichever machine the seat works on.
2. `musterd.db` must not carry per-call trace volume on any machine (§3's reason for the file).
3. Content must never leave its machine (§3; ADR 184 §3). No channel may carry it, not even
   optionally.

## Decision

**Structural trace rows travel joiner → hub on a dedicated push, from `trace.db` to `trace.db`. They
never enter `sync_log` or `audit`, and the hub never sends them onward.**

### 1. One direction: joiner to hub

The hub is where the corpus lives, and trace rows decide nothing: they are residence-2 facts in ADR
325's terms. So the only reader that needs every seat's rows is the hub. A joiner does not receive
other machines' traces. A future view on a joiner (increment 4, human-gated) reads through the hub's
HTTP routes, the same way `musterd trace show` reads through a daemon today.

### 2. The route: `POST /teams/:slug/sync/trace`

The route is on the hub. It authenticates with the joiner's `msnode_` machine credential and
refuses exactly as `/sync/push` does: one refusal for an absent, wrong-kind or revoked credential.
The body is `SyncTracePushRequestSchema`: `{ rows: SyncTraceRow[1..1000] }`, parsed at the boundary
and `.strict()`. A `SyncTraceRow` carries the structural columns and nothing else: `id`, `seat`,
`session_digest`, `seq`, `ts`, `received_at`, `harness`, `kind`, `tool_name`, `tool_use_id`,
`agent_id`, `parent_agent_id`, `duration_ms`, `outcome`, and `detail` (bounded structural JSON).
**The schema has no content field**, so a content-bearing row is a 400, never a partial write. The
pusher also SELECTs its columns by name, as `dataset:export` does, so a content column it never
reads cannot be sent.

The hub writes the batch in one transaction into its own `trace.db`: `INSERT OR IGNORE` on `id`,
with the origin's `seq`, `ts` and `received_at` kept verbatim, and a new column `origin_node` set
to the pushing node (trace ladder v3; `NULL` means the row was minted here). A repeated batch is a
no-op, so delivery is at-least-once with idempotent apply. The reply is `200 { accepted, ignored }`.

### 3. Residence: a node speaks only for its own seats

Every row's `seat` must resolve to a member of the team that `seat_nodes` binds to the pushing
node. This is ADR 360's ingest rule applied to a new surface. A row naming a seat bound elsewhere
refuses the whole batch with `403 bound_elsewhere`, in the `/sync/push` shape. A seat the hub
cannot resolve (git lag) refuses with `409 unresolved_seat`, and the pusher retries the same batch
next tick. The joiner's cursor does not move on either refusal.

### 4. The pusher rides the existing loop, with its own cursor

On an enrolled joiner, each `startSyncPush` tick (60 s) also offers unpushed trace rows: at most
one batch of 1,000 per team per tick, and only for teams this machine has enrolled. So a
never-enrolled machine and the hub itself do nothing. The cursor is the highest acked `rowid`,
kept in the joiner's own `trace.db` under `schema_meta` key `sync_trace_cursor:<team_id>`: it
describes rows of that file, so it lives there, not in `musterd.db`. It advances only past a batch
the hub acked, as the `/sync/push` cursor does. A failed trace push is logged at warn and never
touches the coordination push. The two cursors are independent, so a trace outage cannot wedge
coordination sync, and a coordination refusal cannot drop trace rows.

Rows the hub has taken stay on the joiner; this ADR adds no deletion. Content prunes locally under
ADR 445 increment 3a's lifecycle, and structural rows keep the messages table's lifetime on both
machines.

### 5. Cost, stated

- `musterd.db`: zero new bytes on any machine. No `sync_log`, `audit`, or `record` rows.
- Hub `trace.db`: grows by the joiners' structural volume. Today that is one joiner and one agent
  seat. At the hub's own rate it would be about 7.7 MB a day per busy joiner, which increment 3a's
  `trace.db` size line on `musterd status` makes visible.
- Wire: one POST per enrolled team per minute while rows are waiting; nothing when idle.

## Considered and rejected

- **(a) Coalesced `record` events**: one `record.trace_rows` per seat per window. This cuts the row
  count about 100×, but not the bytes. Every row still lands in `audit` and `sync_log` on the origin
  and the hub, then fans out to every joiner's `audit`, which is about 7–15 MB a day of coordination
  store per machine. The coordination log's guarantees (a gapless per-origin sequence, a canonical
  hub order) cost money here and buy nothing: trace rows are never ordered against acts, and they
  join on `(session_digest, tool_use_id)`, not on `hub_seq`.
- **(c) Hub-only corpus, no replication.** This costs nothing to build, and the joiner's seats are
  silently absent from the dataset. The two-machine dogfood run (lane `01M2H2MP1F`) is exactly when
  a second machine's traces start to matter.
- **Bidirectional replication (every machine holds every trace).** No reader on a joiner needs the
  hub's traces, and every machine would pay the whole team's volume. If increment 4's views ever
  need that, they can read through the hub.
- **Carry content on the channel, gated by policy.** No. ADR 445 §3 and ADR 184 §3 put content on
  the operator's own disk only, and a channel that *could* carry it is one misconfigured flag from
  doing so. The schema has no field for it.

## Consequences

- `@musterd/protocol` gains `SyncTraceRowSchema`, `SyncTracePushRequestSchema` and
  `SyncTracePushResponseSchema` under this ADR, plus two refusal codes on the route's error body,
  reusing existing codes: `bound_elsewhere` and `conflict` with `reason: 'unresolved_seat'`.
- The trace ladder moves to v3: `trace_events.origin_node TEXT` (NULL = minted here), plus an index
  on `(team_id, origin_node)` for the replication read-back.
- `corpus:snapshot` needs no change: the hub's `trace.db` now holds joiner rows, and they are
  captured with it. `dataset:export` needs no change: `origin_node` is not exported, because a node
  id is machine identity, and the seat pseudonym already carries the per-seat view.
- ADR 445 gets a dated Consequences note, and a Decision marker once this ADR is accepted, pointing
  §3's replication clause here.
- What is NOT decided here: joiner-side views (increment 4, human-gated), pruning structural rows,
  and any hub-to-joiner trace traffic.

### Increments

1. This ADR (proposed), for nick's acceptance.
2. Build: the protocol schemas, trace ladder v3, the hub route with its residence check, the
   joiner pusher on the push tick with its `trace.db` cursor, and tests. The tests cover the
   content-field refusal, idempotent re-push, `bound_elsewhere` refusing the batch, the cursor
   holding on refusal, the cursor advancing on ack, a hub that never pushes, and a trace outage
   leaving the coordination push unaffected. Then update the docs: 01/02/03 architecture and the
   research-corpus wiki.

## Observability & Evaluation

- **Traces:** a `musterd.trace.replicated` counter on the hub, by origin node (accepted / ignored);
  a `trace_push_failed` warn line on the joiner, with the status and the cursor. No audit row per
  batch, because that would put per-minute rows back into `musterd.db`.
- **Eval:** after increment 2 on the dogfood pair, once `delta` has worked a session on
  `850e40a4499168`, run on the hub
  `SELECT origin_node IS NOT NULL AS replicated, count(*) FROM trace_events GROUP BY 1`. It must
  show replicated rows, and `SELECT count(*) FROM sync_log` must grow by nothing that
  `json_extract(payload,'$.kind')` names as a trace. Fails if a joiner seat's session is absent on
  the hub after two ticks, or if any hub row carries non-null `content` with a non-null
  `origin_node`.
- **Experiment:** negative tests ship with increment 2: a content-bearing row is a 400; a row
  naming a hub-bound seat is a 403 and nothing is written; and a repeated batch is accepted with
  `ignored = n` and no duplicates.
