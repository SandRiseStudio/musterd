# Federation increment 3b-i — the sync wire format and push

- Date: 2026-08-28
- Lane: `01M12FKECH1CA0DCY7X3H0KMBE`
- Branch: `stanley/federation-sync-push`
- Author: stanley
- Status: design, awaiting nick's review

Build task under [ADR 325](../../decisions/325-multi-machine-federation.md), on the substrate
[ADR 331](../../decisions/331-ordering-substrate.md) laid and the credential
[ADR 328](../../decisions/328-machine-credential.md) minted (increment 3a, landed `3b8415cf`). No new
ADR unless the build contradicts one — the same test that produced 331.

## The slice, and why it is half of 3b

ADR 325 names increment 3's sync half as one thing. It is two, and the seam is not where I first put
it:

| Slice | Contents | Writes to `messages`? |
| --- | --- | --- |
| **3b-i — this document** | wire format, daemon→hub push, hub ingest, canonical order | **no** |
| 3b-ii | pull by cursor, the fold into `messages`, gap detection on the read side | yes — one path |
| 3c | hub-authoritative claim CAS, seat→node residence binding | — |

**Everything a pushed event touches on the hub is a staging log, not `messages`.** That is the whole
reason the split works, and my first attempt at it was wrong: I had assumed the hub could ingest
straight into its own `messages` table and that only the *puller* faced the hard problems. It does
not and they do not. The hub inserting a foreign-origin row is the same act a puller performs, with
the same two hazards, so putting it in this slice would have moved the danger rather than deferring
it.

```
daemon                         hub
  messages ──── push ────▶  sync_log        (append-only, hub_seq = canonical order)
                                │
                                └── fold into messages ── 3b-ii, ONE implementation,
                                                          run by hub and puller alike
```

Two properties follow, and both are the point:

- **Exactly one piece of code ever writes a foreign-origin row into `messages`**, and it lands in the
  slice whose review is about that.
- **The hub's own fold is the same function a puller runs.** By the time a remote daemon depends on
  it, it has been exercised on the hub against real pushed traffic.

Nothing applies remotely in 3b-i. A partitioned or half-synced team reads exactly its own log, which
is what it reads today.

## Two hazards this slice is shaped around

### 1. `messages.from_member` cannot be replicated

`from_member` is `NOT NULL REFERENCES members(id)`, and ADR 325 keeps `id`/`token_hash` as
**daemon-private anchors**: roster identity replicates via git (ADR 058), not through the hub. The
same person therefore has a different member id on every daemon, and shipping the id would either
dangle or — worse — resolve to a *different* seat that happens to hold that id locally.

The wire format carries the seat **name**, which git makes stable across daemons. Resolution to a
local id happens at the fold, in 3b-ii.

This costs almost nothing to adopt, because `Envelope` already works this way: `from` is a name and
`team` is a slug. **The sync event is `Envelope` plus the origin pair, not a new shape** — which is
worth stating plainly, since inventing a parallel message shape here would have been the easy
mistake and would have needed keeping in step with `EnvelopeSchema` forever.

### 2. This is the second insert path ADR 331 warned about

331 §Consequences: *"the single-insert-path property — one production caller, one function — stops
being incidental and becomes load-bearing: a second insert path that skipped `insertMessage` would
break gaplessness rather than merely duplicating logic."*

A replicated event **must not** go through `insertMessage`: that function stamps the *local*
`origin_node` and increments the *local* `next_seq`. A pulled event has to keep the stamp it was
minted with, untouched. So the path 331 warned about is not avoidable — it is this work's core.

3b-i's answer is to not build it yet, and to make the eventual build structurally safe: `sync_log`
has no `next_seq` and no relationship to `nodes.next_seq`, so nothing in this slice *can* advance a
counter it does not own. 3b-ii's fold will take the same discipline, and is where the falsifier for
it belongs.

## Decisions this design makes

### 1. The wire event is `Envelope` + `(origin_node, origin_seq)` + `from_provenance`

```ts
export const SyncEventSchema = z.object({
  envelope: EnvelopeSchema,          // id, v, team (slug), from (NAME), to, act, body, thread, meta, ts
  origin_node: z.string().min(1),
  origin_seq: z.number().int().positive(),
  from_provenance: z.string().nullable(),
});
```

Composing `EnvelopeSchema` rather than restating its fields means the act vocabulary, the `meta`
rules and the slug regex stay in one place; a future act cannot be replicable-but-unvalidated.

**`from_provenance` travels; `created_at` does not.** Provenance is an attested fact about the event
— how the sending session was animated (ADR 131 §4) — and ADR 101/158's whole reason for stamping
attestation per-event at insert is that it survives replication. `created_at` is local receipt time:
the receiver stamps its own, and shipping the origin's would assert a falsehood about when this
machine learned of it.

**`origin_seq` is `positive()`, not `nonnegative()`.** `next_seq` holds the *next* value to assign
and starts at 1 (ADR 331 §Decision 2), so seq 0 never exists. A schema that admits it invites a
reader to treat 0 as "unset".

### 2. A node may push only its own events

The hub rejects any batch containing an event whose `origin_node` is not the authenticated node's id.

This is ADR 328 §1 made operational: *"an event's origin is a fact the hub authenticated at ingest,
not a string the sender chose."* Without the check that sentence is aspirational — an admitted node
could mint events attributed to any other node, and `origin_node` would stop meaning anything the
moment a second machine was compromised. The check is one comparison and it is the reason the stamp
is worth carrying at all.

### 3. Idempotence is a UNIQUE index, not bookkeeping

`sync_log` carries `UNIQUE(origin_node, origin_seq)` and ingest is `INSERT … ON CONFLICT DO NOTHING`.
A replayed batch — the realistic case, since a lost ack means the pusher retries — is a no-op.

This is the property `seeds/ingest.ts` already demonstrates ("idempotence on a foreign immutable
id"), and ADR 325 named that module as the pattern to generalize. The pair is a better key than the
message ULID alone: it is what the protocol *orders* by, so a duplicate under it is a duplicate in
the only sense the sequence cares about.

### 4. The hub refuses a gap at ingest and says where to resume

For each `origin_node` the hub tracks the highest contiguous `origin_seq` it holds. A batch whose
first event is not the successor is refused with `409` and the expected next seq.

Refusing at the boundary rather than accepting-and-sorting is the cheaper half of ADR 331's promise.
The alternative is a merged log that *contains* holes and a consumer that has to decide, later and
with less information, whether seq 7 is lost or merely unsent — the exact ambiguity 331 exists to
prevent. Here the pusher is still holding the events and can simply resume.

The refusal names the expected seq because a pusher that cannot self-correct will retry the same
rejected batch forever.

### 5. `hub_seq` is the canonical total order, assigned per team on ingest

ADR 325: *"The hub assigns the canonical total order on ingest."* `sync_log.hub_seq` is a per-team
monotone counter on `sync_meta.next_hub_seq`, allocated inside the same transaction as the insert —
the shape `insertMessage` established for `next_seq` in increment 2, and correct for the same reason:
SQLite's single writer means the read-bump-insert cannot interleave.

Order of ingest, deliberately, not order of `ts`. Wall-clock across machines is exactly what ADR 331
§Context says cannot be trusted; arrival at the one authority is a fact the authority observed.

## Data

**Migration v50.** Two tables. `messages` and `nodes` are untouched.

```sql
CREATE TABLE IF NOT EXISTS sync_log (
  id           TEXT PRIMARY KEY,        -- the message's own ULID
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  origin_node  TEXT NOT NULL REFERENCES nodes(id),
  origin_seq   INTEGER NOT NULL,
  hub_seq      INTEGER NOT NULL,        -- canonical total order, per team
  payload      TEXT NOT NULL,           -- the SyncEvent, verbatim
  received_at  INTEGER NOT NULL
);
-- The idempotence key (decision 3) and the canonical-order key. The second is UNIQUE rather than a
-- plain index on purpose: it enforces decision 5's density claim in the schema instead of trusting
-- the allocator, and it is the index 3b-ii's cursor read will walk, so no third index is needed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_log_origin ON sync_log(origin_node, origin_seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_log_hub ON sync_log(team_id, hub_seq);

CREATE TABLE IF NOT EXISTS sync_meta (
  team_id       TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  next_hub_seq  INTEGER NOT NULL DEFAULT 1
);

-- What this daemon has successfully pushed, per (team, node). Local-only, never replicated
-- (ADR 325 residence 3): it describes this machine's conversation with a hub, not team state.
CREATE TABLE IF NOT EXISTS sync_push_cursor (
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  last_seq    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, node_id)
);
```

`payload` stores the event verbatim rather than exploded into columns. The fold is 3b-ii's decision,
and a staging row that has already dropped a field cannot be re-folded when that decision changes.

Guarded `CREATE`s throughout: the migration tests rewind `schema_version` and replay the tail. No
backfill — a log of what has been *pushed* has no history before pushing exists.

## Surface

**Protocol** — `packages/protocol/src/sync.ts`: `SyncEventSchema`, `SyncPushRequestSchema`
(`{ events: SyncEvent[] }`, max 500 per batch), `SyncPushResponseSchema`
(`{ accepted: number, hub_seq_high: number }`), `SyncGapResponseSchema`
(`{ error, expected_seq }`).

**Store** — `packages/server/src/sync/log.ts`:

| Function | Guard |
| --- | --- |
| `ingestBatch(db, teamId, nodeId, events, now?)` | origin must equal `nodeId`; contiguity; `ON CONFLICT DO NOTHING` |
| `highestContiguousSeq(db, nodeId)` | — the resume point a refusal reports |
| `hubHead(db, teamId)` | — highest `hub_seq`, for the push ack |

**Push loop** — `packages/server/src/sync/push.ts`, shaped like `seeds/ingest.ts`: a 60s interval,
no stacked passes, per-team try/catch so one unreachable hub cannot stall another team. Reads
`sync_push_cursor`, selects `messages` for this node above the cursor, posts, advances only on a
`200`. Offline is the expected failure — the events are still in `messages`, which is the buffer.

**Route** — `POST /teams/:slug/sync/push`, authenticated by `msnode_` via `authenticateNode` (3a's
first real consumer). Not `isLocalPeer`-gated, and not seat-authenticated: ADR 328 §3 admits a node
to the sync surface and nothing else.

## Testing

TDD; every row is a test written before its code.

| # | Case | Falsifies |
| --- | --- | --- |
| 1 | A node pushing another node's `origin_node` is refused | **decision 2** — the ADR 328 §1 property |
| 2 | A replayed batch inserts nothing and still acks | idempotence |
| 3 | A batch with a gap is refused, naming the expected seq | decision 4 |
| 4 | Contiguous batches from two nodes interleave without either's sequence breaking | per-origin independence |
| 5 | `hub_seq` is dense and strictly increasing per team under interleaved pushes | decision 5 |
| 6 | An unenrolled or revoked `msnode_` is refused | ADR 328 §5, via `authenticateNode` |
| 7 | A seat credential (`mskey_`/`mscr_`) cannot push | ADR 328 §3 — the axes stay independent |
| 8 | Ingest writes **nothing** to `messages` and does not move any `nodes.next_seq` | **the 331 hazard** |
| 9 | The push cursor advances only past an acked batch; a failed post re-sends | at-least-once |
| 10 | v50 is idempotent under rewind-and-replay | the v31 note |

Case 8 is the one to write first and never delete. It is the difference between this slice being
safe and merely looking safe, and it is cheap: assert `messages` row count and every `next_seq`
unchanged across an ingest.

**Acceptance: two real daemons.** A hub and a joiner enrolled through 3a's ceremony, then real
pushes: the joiner's messages appear in the hub's `sync_log` with the joiner's `origin_node`, its
`origin_seq` gapless, `hub_seq` dense, and — the assertion that matters — the hub's `messages` table
unchanged.

## Out of scope

Pull, the fold into `messages`, and read-side gap detection (3b-ii). Hub claim CAS and seat→node
residence (3c). Origin stamps on lanes, goals and audit (their own slices, ADR 331 §Decision 5).
`inbox_cursors` and `tool_call_stats`, which ADR 325 names as direct-merge exceptions — they are not
events and do not belong in a log ordered by origin.
