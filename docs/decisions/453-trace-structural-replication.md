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
`agent_id`, `parent_agent_id`, `duration_ms`, `outcome`, and `detail`. **The schema has no content
field**, so a content-bearing row is a 400, never a partial write. The pusher also SELECTs its
columns by name, as `dataset:export` does, so a content column it never reads cannot be sent.

**No content field is not enough on its own** (big-body's review, 2026-09-26). The local ingest
schema that `trace_events` rows come from is loose. `TraceDetailSchema` takes any key name with a
string value up to 256 characters (1 KiB in total), and `tool_name`, `tool_use_id`, `agent_id` and
`parent_agent_id` are free strings up to 128 characters. So a holder of a valid `msnode_` could put
prose or secret fragments in those fields, and a named-column SELECT would forward them. The
channel is structural only if every field is **typed so that prose cannot fit in it**. So
`SyncTraceRowSchema` does not reuse the ingest schemas. Its fields are typed as follows:

| field | rule |
| --- | --- |
| `id` | ULID: `^[0-9A-HJKMNP-TV-Z]{26}$` |
| `seat` | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`, and it must resolve to a team member (§3) |
| `session_digest` | `SessionDigestSchema` (8–32 lowercase hex; the ADR 131 keyed HMAC, never a raw session id) |
| `harness` | `HarnessIdSchema` (ADR 281: `^[a-z0-9][a-z0-9._-]{0,63}$`) |
| `kind`, `outcome` | closed enums (`TraceEventKindSchema`, `TraceOutcomeSchema`) |
| `tool_name` | `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`, **and** the credential detector finds nothing in it (below) |
| `tool_use_id`, `agent_id`, `parent_agent_id` | **`^[0-9a-f]{24}$`: a keyed digest, never the harness's raw id** (below) |
| `seq`, `ts`, `received_at`, `duration_ms` | non-negative safe integers |
| `detail` | `TraceStructuralDetailSchema`, below |

`TraceStructuralDetailSchema` is **per kind** and closed. Each `kind` names the keys it may carry,
and each key has one value type:

- **count** (a non-negative safe integer): `exit_code`, the `*_bytes` sizes, the `*_tokens`
  totals, `tool_uses`.
- **flag** (a boolean): `raised`, `deaf`, `encrypted`, `stop_hook_active`, `suppressed`,
  `downgraded`.
- **enum** (a closed producer allowlist): `hook` (`gate`, `interrupt`, and each hook musterd
  registers), `hook_event`, `decision`, `source`, `reason`, `parser` (`<harness>@<n>`, exactly the
  versions the parsers stamp), and `type` (the transcript record types the parsers recognise). The
  lists are the values measured on 2026-09-26 plus every value the source can emit, and they live
  beside the producers in `@musterd/protocol`.
- **model id** (`model` only): `^[a-z0-9][a-z0-9.-]{0,63}$`, lowercase with no underscore.
  Every live value fits (`claude-opus-5-5`, `claude-fable-5-1`, …). No `TOKEN_PREFIXES` credential
  can match, because every prefix contains `_` (`mskey_`, `msgr_`, `mscr_`, `msac_`, `msls_`,
  `msnode_`, …). A test asserts that for every registered prefix, so a future prefix without an
  underscore fails CI.

A key outside its kind's list, or a value outside its key's type, fails the schema. A new
producer value (a new transcript `type`, a new hook) is added to its list in the same change that
starts emitting it. Until then, local ingest and the pusher normalize it to `other`, so it arrives
as a count, never as text.

**Opaque ids cross as keyed digests** (big-body's second review). The ids exist for joining: R1 to
R2 by `tool_use_id`, subagents by `agent_id`. Nothing needs their raw form off the machine. So the
pusher replaces `tool_use_id`, `agent_id` and `parent_agent_id` with `HMAC-SHA256(k, id)`, truncated
to 24 hex characters. The key is not the one behind `session_digest`: that digest is keyed by the
team's agent key inside the tap, and the daemon holds only that key's hash (ADR 131 §5). The key is
instead a random 32-byte secret, generated once in the joiner's `trace.db` `schema_meta`
(`sync_trace_id_key`). It is never sent anywhere and never logged, and it is kept for the file's
lifetime. The same id always digests the same way on that machine, so every join the hub makes
inside a joiner's rows still holds. A 24-character hex string cannot carry a credential or prose, whatever
the harness put in the raw id. The hub's own locally minted rows keep their raw ids. They never
leave the hub, and joins never cross machines, because sessions don't.

**A credential detector at every boundary.** `scrubCredentials` (`traceScrub.ts`, ADR 445 1b)
already recognises every `TOKEN_PREFIXES` shape and the generic bearer/API-key shapes. It runs over
every string field of a sync row: the hub rejects the batch if it finds anything, and local ingest
and the pusher null the field. After the digest and enum rules, only `tool_name` is still an open
string; the detector covers it and, as defence in depth, everything else.

**The threat model, stated so the schema is judged against the right attacker.** These rules make
the channel structural-only against **honest-but-buggy producers**: a tap that puts the wrong
thing in a field (the Cursor newline ids are a live example), or a harness that changes a format.
They also guarantee the corpus and the public dataset receive no content or secrets. They are
**not** a boundary against a malicious enrolled node. A holder of a valid `msnode_` can already
push acts with prose bodies on `/sync/push` under ADR 325's trust model, and the answer to that is
revoking the node, not a schema. So the claim is precise: nothing an honest musterd pusher sends can
contain content or a credential, and the hub refuses any row that could. The per-kind
key lists are the set the taps and parsers write today, as measured on the dogfood `trace.db` on
2026-09-26. They live in `@musterd/protocol` as one table, and `dataset:export`'s
`TRACE_DETAIL_KEYS` derives from it, so the public dataset and the sync channel share one
definition of "structural".

**Enforced at three points, with a different response at each:**

1. **Hub, `/sync/trace`: reject.** A batch with any non-conforming field is a 400, and nothing is
   written. This is the boundary against a joiner that does not run musterd's pusher.
2. **Joiner pusher: normalize before sending.** A non-conforming identifier is sent as `null`, and
   a non-conforming `detail` key is dropped. Rows stored before this ADR, or by an older tap, reach
   the hub reduced rather than wedging the cursor on a 400 forever.
3. **Local ingest (`POST /teams/:slug/trace/events`): normalize the same way, never reject.** A tap
   must not lose a row over one odd field. The row is stored with that field nulled or dropped, and
   a `normalized: n` count goes in the ingest counter. This tightens ADR 445's local store under the
   same definition, so the three boundaries agree.

The measurement that shaped rule 3: every live value conforms except **104 Cursor `tool_use_id`s,
each containing a newline**, with two harness ids joined together (`call-…` over `fc_…`). That is a
Cursor-tap defect, and increment 2 fixes it at the tap by taking the first id, so Cursor rows keep
their R1↔R2 join key instead of being nulled. Rows already stored that way are normalized to `null`
on their way out.

The hub writes the admissible rows (§3) in one transaction into its own `trace.db`, with the
origin's `seq`, `ts` and `received_at` kept verbatim, and a new column `origin_node` set to the
pushing node (trace ladder v3; `NULL` means the row was minted here). Each row is an
`INSERT OR IGNORE`, and a row that inserts nothing is classified by one lookup. If a row with the
same `id` is held, it counts as **`ignored`**: a re-push, so delivery is at-least-once with
idempotent apply. Otherwise the row hit `UNIQUE (team_id, session_digest, seq)` under a different
`id`, and it counts as **`collided`**. That is a digest collision, never expected, and it is
counted apart so that it cannot hide inside the re-push count. The reply is
`200 { accepted, ignored, collided, refused: [{ id, code }] }` (§3).

### 3. Residence: a node speaks only for its own seats

Every row's `seat` must resolve to a member of the team that `seat_nodes` binds to the pushing
node. This is ADR 360's ingest rule applied to a new surface, but the refusal takes a different
shape, and the reason is ordering. `/sync/push` refuses a whole batch because its log is a gapless
per-origin sequence, and a hole cannot be skipped. Trace rows have no such order: §Considered (a)
rests on exactly that. They are also judged against the binding as it stands NOW, not at their
`ts`. A seat that recorded traces on the joiner and was later rebound (ADR 328 trust or unbind)
leaves rows that would refuse forever. Under a whole-batch refusal, those rows would stall every
later row from every seat on that node, with nothing but a warn line to show it (dolly's review,
2026-09-26). So:

- **Bound elsewhere → refused per row, and the batch goes on.** The row is not written. It is
  listed in the reply's `refused: [{ id, code: 'bound_elsewhere' }]`, counted on the hub counter,
  and counted in the joiner's warn line. The joiner's cursor advances past it like any acked row.
  The row stays in the joiner's own `trace.db`, so nothing is lost locally. The hub simply does
  not take a claim it cannot attribute.
- **Unresolvable seat (git lag) → `409 unresolved_seat`, and the whole batch holds.** This refusal
  is transient: the roster reconcile catches up, and the same batch lands on a later tick. The
  cursor does not move.
- **A seat bound to no node at all → `409 unbound_seat`, held like the case above.** The trace
  surface never mints a binding. Binding is ADR 328's claim path, and a trace row is not a claim.
  The batch waits until the seat's first real claim binds it.
- **No audit row for any of these.** The claim path writes a `seat.bound_elsewhere` deny row into
  `musterd.db` (`sync/claim.ts`). The trace route must not reuse that path: a refusal that repeats
  every tick would put a row in `musterd.db` every minute, which is exactly the growth §5 rules out.
  Refusals live in the reply, the hub counter and the joiner's log line.

### 4. The pusher runs its own loop, with its own cursor

`startSyncPush` is one async pass per tick, behind a `running` guard, and it awaits each team in
turn (`sync/push.ts`). A trace POST inside that pass would couple the two channels by scheduling,
even with separate cursors. A slow hub would delay the next team's coordination push by up to the
trace timeout, on every tick, and a thrown trace error inside a team's `try` would skip the rest of
that team. So the trace pusher is **its own loop**: `startTracePush`, started and stopped beside
`startSyncPush`, on its own 60 s interval, with its own `running` flag, its own per-team
`try/catch`, and its own `AbortSignal.timeout` on each fetch. With that, "no coupling either way"
holds by construction, and the eval below tests it.

On an enrolled joiner, each tick offers at most one batch of 1,000 unpushed rows per enrolled team.
A never-enrolled machine and the hub itself do nothing. The cursor is the highest acked `rowid`,
kept in the joiner's own `trace.db` under `schema_meta` key `sync_trace_cursor:<team_id>`. It
describes rows of that file, so it lives there, not in `musterd.db`. `rowid` is sound as a cursor:
`trace_events` is a rowid table, and nothing deletes from it (the content prune is an `UPDATE`), so
`rowid` only grows. The cursor advances past a batch only once the hub has answered `200`,
including past the rows that reply lists as `refused` (§3). It holds on a `409`, on any other
error, and on a timeout. A failed pass is a `trace_push_failed` warn line with the status and the
cursor.

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

- `@musterd/protocol` gains `TraceStructuralDetailSchema` (the per-kind key table) and the typed
  identifier patterns. It also gains `SyncTraceRowSchema`, `SyncTracePushRequestSchema` and
  `SyncTracePushResponseSchema` (`{ accepted, ignored, collided, refused: [{ id, code }] }`) under
  this ADR. The batch-holding refusals reuse the existing `conflict` code, with
  `reason: 'unresolved_seat' | 'unbound_seat'`. The per-row refusal code is `bound_elsewhere`.
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

1. This ADR (proposed), for acceptance by its reviewing seat. It was declined twice on 2026-09-26
   and amended both times. dolly's four changes are in §2–§4. big-body's structural-only finding is
   the §2 field table and the three enforcement points.
2. Build: the protocol schemas, trace ladder v3, the hub route with its per-row residence check,
   `startTracePush` with its `trace.db` cursor, and tests. The tests cover: the content-field
   refusal; idempotent re-push (`ignored`); a digest collision under a new id (`collided`); a
   bound-elsewhere row refused alone while its batch-mates land and the cursor advances past it;
   `unresolved_seat` and `unbound_seat` holding the cursor; the cursor advancing on ack; a hub that
   never pushes; no audit row written on any refusal; and a stalled `/sync/trace` leaving the
   `/sync/push` cadence unchanged. **Field-by-field negative tests** (big-body): for every
   `TOKEN_PREFIXES` entry, a syntactically valid credential (`mskey_` + 43 base64url characters,
   `msgr_…`, and so on) is placed in `tool_name`, in each id field, in `model` and in each
   enum-typed `detail` key. The hub must reject it before storage, and the pusher and local ingest
   must null it. The same holds for prose (a sentence, a path, a newline) and for an unlisted
   `detail` key. A positive test shows the digest keeps the R1↔R2 join inside a joiner's rows. The
   `TraceStructuralDetailSchema` and the ingest normalizer land together, with the Cursor tap fix. Then update the docs: 01/02/03 architecture and the
   research-corpus wiki.

## Observability & Evaluation

- **Traces:** a `musterd.trace.replicated` counter on the hub, by origin node and outcome
  (accepted / ignored / collided / refused); on the joiner, a `trace_push_failed` warn line with the
  status and the cursor, and a `trace_rows_refused` line with the count and the seat names. No audit
  row per batch or per refusal, because that would put per-minute rows back into `musterd.db`.
- **Eval:** after increment 2 on the dogfood pair, once `delta` has worked a session on
  `850e40a4499168`, run on the hub
  `SELECT origin_node IS NOT NULL AS replicated, count(*) FROM trace_events GROUP BY 1`. It must
  show replicated rows, and `SELECT count(*) FROM sync_log` must grow by nothing that
  `json_extract(payload,'$.kind')` names as a trace. Fails if a joiner seat's session is absent on
  the hub after two ticks, or if any hub row carries non-null `content` with a non-null
  `origin_node`.
- **Experiment:** negative tests ship with increment 2. A content-bearing row is a 400, and so is a
  row carrying prose in any structural field (the §2 table, field by field). A row naming
  a hub-bound seat is refused alone: `refused` lists it, its batch-mates are written, and no audit
  row appears. A repeated batch is accepted with `ignored = n` and no duplicates. A `/sync/trace`
  stalled past its timeout leaves `/sync/push`'s tick-to-tick interval unchanged.
