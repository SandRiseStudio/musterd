# Federation data census

What each table in the daemon's store is (event, state, or ephemera), how writes actually happen, and what the 2025–26 sync/DB landscape offers — the fact base under [ADR 325](../decisions/325-multi-machine-federation.md).

All codebase claims measured 2026-08-25 at `3162aa16` (migrations at v44). The store evolves;
re-verify against `packages/server/src/db/migrations.ts` before leaning on a row below.

## Residence census, per table (2026-09-03 at `6a6304a7`, migrations at v64; lane 01M1JNNF42)

Re-measured on two real daemons after the 3a–3e increments (ADRs 328–361). "Crosses" means a
row minted on one machine is read back on the other after one push/pull round trip
(`sync/census.test.ts`). The 2026-08-25 four-residence classification below is kept as the
pre-federation baseline.

| table | ADR 325 residence | mechanism today | crosses? | note |
|---|---|---|---|---|
| `messages` | 2 (event) | `insertMessage` stamps `(origin_node, origin_seq)`; push ships every stamped row; fold inserts by name | **yes** | residence-checked at ingest per kind (ADR 360) |
| `audit` — `lane.*` | 1 (via events) / 2 | `appendReplicatedEvent` stamps; fold projects onto `lanes` | **yes** | ownership/state edges decided on the hub first (ADR 355/361) |
| `audit` — `presence.*` | 3, amended → 2 | same stamped path; fold writes `presence` rows with `node` | **yes** | ADR 356 |
| `audit` — `policy.change` | 1 | `appendReplicatedEvent` via `applyPolicyChange` (hub only); fold projects onto `teams.policy` | **yes** (2026-09-03, ADR 367) | the fourth replicated kind; exempt from residence binding at ingest — the hub mints it on a joiner admin's behalf |
| `audit` — the ledger set: the six wake verbs (ADR 365) + the `residency.*` remainder and `mcp.surface_rendered` (ADR 371 §4) | 2 (insight) | `appendAudit` consults `REPLICATED_LEDGER_VERBS` and stamps; fold appends, projects nothing | **yes** (2026-09-03) | every deciding reader pinned `MINTED_HERE` — ADR 371 added the pin to `hostAsleepMs`, `firstWakeLeaseTs`, `leaseCapturedSession`. Falsify: `store/residency.test.ts` "three ADR 371 §4 deciders are pinned" |
| `audit` — everything else (`seat.*`, `memory.*`, `claim.*`, `incident.*`, `ask.*`, `handoff.*`, `inbox.*`, `git.pr_merged`, …) | 2 ("the audited verbs") | `appendAudit`, best-effort, `origin_seq = 0` — never selected by `unpushed` | **no**, by design | a verb joins a set when something reads it across machines (2026-09-03; falsify: `census.test.ts` — an `inbox.deferred` row pushed between two daemons never lands on the receiver) |
| `lanes` | 1 | projection of folded `lane.*`; hub-authoritative CAS for every ownership/state patch | **yes** (as events) | field edits (title, scope, branch) stay local-authoritative and replicate as `lane.updated` |
| `presence` | 3 → 2 (transitions) | folded rows carry `node`; heartbeats/grace/`conn_id` local | **yes** (transitions) | liveness of a remote row = its node's `last_seen_at` |
| `seat_nodes` | hub decision input | hub-minted (ADR 355 §5, 358) | n/a — hub-only by design | a joiner asks, never reads it |
| `nodes` (liveness) | hub | `upsertForeignNode` on the pull summary | **yes** (identity + `last_seen_at`) | credentials never leave the hub |
| `teams.policy` | 1 (admission/policy is hub-authoritative) | hub `POST /policy` → `applyPolicyChange` (stamped); a joiner forwards to `POST /sync/policy` and writes nothing; fold applies the sparse doc with replace semantics | **yes** (2026-09-03, ADR 367 — GAP 1 CLOSED) | the 21 readers incl. `claimWakeLeases` now agree across machines after one tick. An unreachable hub refuses `hub_unreachable`. Falsify: `sync/policy.test.ts`; `census.test.ts` also pins that raw `setPolicy` still ships nothing |
| `seat_memory` | 2 (LWW blob, on the ORIGIN's `saved_at`) | `applyMemorySave` / `applyMemoryClear` (stamped, `continuity.memory_saved` / `_cleared`); fold applies LWW; raw `saveMemory` still ships nothing | **yes** (2026-09-03, ADR 366 — GAP 2 CLOSED) | the event CARRIES THE BODY — ADR 093 hard rule 5 overturned by decision; the audit log now holds notes, daemon-side only, never git. A clear is a fact with a clock. Falsify: `sync/continuity.test.ts`; `census.test.ts` pins that the raw primitive is silent |
| `inbox_cursors` | 2 — but NOT the "monotone max" the baseline promised | `applyCursorAdvance` (stamped, `continuity.cursor_advanced`, carries the MESSAGE ID only); fold resolves the id against its own `messages.created_at` and takes the max there | **yes** (2026-09-03, ADR 366 — GAP 2 CLOSED) | `last_read_ts` is a receipt clock and differs per machine, so the raw number never crosses (lane `01M1FAYTHQ`'s defect in federated form). A cursor naming an unfolded message stops the fold (`cursor_unborn`) |
| `tool_call_stats` | 2 (additive counters) | `applyToolCalls` (stamped, `record.tool_calls`, carries the flush + the origin's `bucket_start`); fold runs the same additive UPSERT; raw `recordToolCalls` still ships nothing | **yes** (2026-09-03, ADR 371 — GAP 3 CLOSED) | exactly-once by the fold's held-pair rule, not by any counter logic. Falsify: `sync/record.test.ts` re-folds the staged log and the count holds |
| `seed_thread_entries` | 2 | `applyThread` (stamped, `record.seed_thread`, carries `relay_id` + member NAME + the entry id — `seeds.id` and `members.id` are daemon-private); fold resolves both locally; a seed not yet relay-ingested here stops `seed_unborn` | **yes** (2026-09-03, ADR 371 — GAP 3 CLOSED) | the thread is whole everywhere; the seed's lifecycle STATE beside it still is not (next row) |
| `seeds` (lifecycle) | 2 | relay-ingested per daemon, or repo-captured by `pnpm intents:ingest` on whichever daemon the seat runs it against (ADR 373 inc 2, 2026-09-03 — a repo Seed is as one-machine as a relay one); state moves local | partial — the relay, not the hub | two daemons can move one seed differently (2026-09-03; falsify: claim a seed on two daemons and read `explorer_id` on each — both hold one). ADR 371 §3 names this and leaves it: an explorer claim is "exactly one holder", residence 1, its own lane |
| `incident_reports` | **1** — the pool is COUNTED, and a count is a decision (ADR 371 §2) | the HUB records at route time or when a joiner's `status_update` folds (`handleFoldedMessages`); a joiner skips the hook and writes nothing; hub rows mirror back as `record.incident_report` | **yes** (2026-09-03, ADR 371 — GAP 3 CLOSED) | one lane per gate for the whole team; `incidentReporters` answers on a joiner from the mirror; a joiner-pushed pool row is refused 403 at ingest. Falsify: `sync/record.test.ts` |
| `wake_turns` | 2 (promised explicitly) | `appendWakeTurn`, lease-scoped, unstamped | **no** — GAP, but see note | a wake runs where the seat is enrolled (ADR 361 correction); its turns are read only by that host's report path. Cross-machine *cost* insight is the loss, and that is the unstamped `residency.wake_cost` verb above, not this table |
| `requests`, `grants`, `session_leases`, `agent_bootstrap_credentials` | 3 / local secrets | local | no, by design | short-TTL or credential-bearing |
| `residency`, `wake_leases`, `host_liveness`, `footprint_*`, `sync_*`, `local_node`, `schema_meta` | 3 | local | no, by design | ADR 325 residence 3; the wake ledger is derived from `messages` on the host's poll, so a folded act still wakes (wake-leases.md, 2026-09-03) |
| `members`, `roles`, team/seat identity | D (git) | projection from `.musterd/*.toml` | via git | unchanged |

**What the push selects, verbatim** (`sync/push.ts` `unpushed`, 2026-09-03): every `messages`
row and every `audit` row with `origin_node = <this node>` and `origin_seq > cursor`. There is no
action filter on the audit side — the *stamp* is the filter, and only `appendReplicatedEvent`
stamps. The action *prefix* picks the wire tag (the ledger set → `ledger`, `presence.` → `presence`, `policy.` →
`policy`, `continuity.` → `continuity`, `record.` → `record`, otherwise `lane`), and the hub and
fold branch on the tag, never on the prefix. Falsify: stamp a
verb with none of those prefixes and push; the hub stages it and the joiner's fold stops at
`unknown_lane_event`.

### Gaps, ranked, with the lane each needs

1. ~~**`teams.policy`**~~ — **closed 2026-09-03 by [ADR 367](../decisions/367-team-policy-is-the-hubs-and-replicates.md)** (lane `01M1JNXSV7`), exactly as shaped here: a joiner's `POST /policy` forwards to the hub, the hub's `policy.change` is stamped, and the fold applies the sparse doc. Two things the shape learned in the building: the event carries the **stored** doc, not the effective one (shipping defaults would kill the schema default on every peer — ADR 185's #530 failure, replicated), and the policy kind is **exempt from residence binding**, or setting policy from a laptop would bind the admin's seat to the hub.
2. ~~**Per-seat continuity: `seat_memory` + `inbox_cursors`**~~ — **closed 2026-09-03 by [ADR 366](../decisions/366-seat-continuity-replicates-with-the-note.md)** (lane `01M1JNY14F`), one lane, two tables, as shaped here — with one correction to the shape: "max-merge trivially" was wrong for the cursor. `last_read_ts` is this daemon's receipt clock for the row and differs on every machine that folded the message, so the event carries the **message id** and the receiver re-reads the position against its own order; max-merging the number would have swallowed unread acts. And the memory event carries the **body**, by decision (nick, ask `01M1JS1PXH0NPZBPPS6V2WYTHY`): a headline is not continuity. That overturns ADR 093 hard rule 5 — the audit log now holds notes, daemon-side only.
3. ~~**Insight substrate: `tool_call_stats` + the unstamped `residency.*` cost/lease verbs +
   `incident_reports` + `seed_thread_entries`**~~ — **closed 2026-09-03 by
   [ADR 371](../decisions/371-the-record-kind-and-the-rest-of-the-ledger.md)** (lane `01M1MJ61JY`),
   after [ADR 365](../decisions/365-the-ledger-kind.md) had taken the six wake verbs. The typed kind
   this row asked for is `record`, with three projectors under one tag; the residency remainder went
   into the ledger set instead, once its three unpinned deciding readers were pinned. One thing the
   shape learned in the building: "nothing here decides anything" was wrong for `incident_reports`
   — the pool is counted, and the count opens a lane, so it moved to the hub (residence 1) rather
   than replicating as a fact. The residence-2 census has no open gap; the seed lifecycle row above
   is the named residue.

## Table classification (2026-08-25 baseline, pre-federation)

Four residences, by what replication would have to do with them:

**A. Append-only facts** — never UPDATEd/DELETEd; replicate as an ordered log.

| table | order | notes |
|---|---|---|
| `messages` | `(team_id, ts)` idx, ULID tiebreak | The coordination stream. One writer (`insertMessage`, `store/messages.ts`), called only from `protocol/route.ts`. |
| `audit` | `(team_id, ts)` idx | ~80 verbs, ~102 call sites — but best-effort by contract (see defects). |
| `seed_thread_entries` | `(seed_id, created_at)` | |
| `wake_turns` | `UNIQUE(lease_id, turn)` | re-post is an overwrite by design |

**B. Mutable current-state** — LWW rows today: `lanes` (the contended one), `teams` (policy
blob), `seeds` (lifecycle machine, transactional), `grants`, `requests` (short TTL), `residency`,
`seat_memory` (LWW blob). Two merge trivially without ordering: `inbox_cursors` (monotone max —
`last_read_ts` only ever advances) and `tool_call_stats` (additive counters + MAX).
*Invalidated 2026-09-03 for `inbox_cursors` (ADR 366): the max is monotone within ONE daemon only.
`last_read_ts` is a receipt clock, so across machines the cursor replicates as a message id and is
re-read locally — it does not merge as a number. `tool_call_stats` still stands as written.*

**C. Local-only, never replicate:** `presence` (15s heartbeat, reaped at 45s, host-bound by
construction; ADR 058's live tier), `wake_leases` (~120s TTL, host-scoped mutual exclusion),
`footprint_*` (deliberately team-less — they measure the machine), `schema_meta`.

**D. Not in SQLite — already replicated via git** (ADR 058): team/seat/role identity in
`.musterd/*.toml`, projected by `packages/server/src/projection/` (idempotent match-by-name delta;
`id`/`token_hash` stay daemon-private).

## Write-path census

There is no single event log all mutations flow through (2026-08-25; falsify: find a funnel every
store write passes — there are two spines plus 16 modules issuing direct UPDATEs). The two spines:
`messages` (clean single funnel) and `audit` (best-effort, transport-layer-called — ~48
`appendAudit` calls in `transport/http.ts` vs 2 in all of `store/`).

The counterweight: 18 store modules write nothing at all — pure read-time derivation (`goals.ts`
has no table; status/epoch/wave fold from message meta. Likewise `delivery.ts`, `activity.ts`,
`orientation.ts`, `quiescence.ts`, `laneSweep.ts`, `laneClose.ts`, …). ADR 048's "derive
everything else" is the codebase's dominant idiom; ADR 131 records the two argued exceptions
(`wake_leases`, `requests`) where stored state is allowed to bear correctness.

Existing sync machinery worth copying: `seeds/ingest.ts` — cursor-based at-least-once pull,
idempotent on `UNIQUE(team_id, relay_id)`, cursor advanced inside the same transaction as the
insert, fail-closed on unrecognized shapes (ADR 248/311). The only cross-boundary sync in the
system, and the pattern ADR 325 generalizes.

## Defects the census surfaced

ADR 325's prereq-fix lane addresses the first four; strike-and-date here as they land.

- ~~**No global ordering primitive** (2026-08-25; falsify: find an `origin_seq`/HLC/logical-clock
  column in `migrations.ts` — there is none).~~ **Landed:** `(origin_node, origin_seq)` on `messages` (v48) and `audit` (v58), ADR 331/335; `incident_reports` on ULIDs (v45). Ordering is wall-clock `(ts, ULID)`.
  `store/residency.ts` tie-breaks on local `rowid` in two queries (~:596, :622), and
  `incident_reports` is the schema's only `INTEGER AUTOINCREMENT` id — both meaningless once rows
  originate on more than one machine.
- ~~**Lane claim is a TOCTOU, not a CAS**~~ **Landed:** guarded `updateLane` CAS (ADR 325 prereq), hub-arbitrated for every ownership/state edge (ADR 355/361). (2026-08-25; falsify: read the lane PATCH handler,
  `transport/http.ts` ~:3115 — look for an enclosing `db.transaction` or a `WHERE
  owner_seat/state` guard on the write; neither exists). `getLane` → ~65 lines of JS policy →
  unconditional `updateLane`. The 2026-08-01 double-claim (lanes 01KYX8J5XD / 01KYXWNX9R, noted at
  ~http.ts:3133) is the recorded cost.
- ~~**The claim's arbitration input is host-local**~~ **Closed by ADR 356** (presence transitions replicate; the hub's incumbent rule sees every machine). (2026-08-25; falsify: read ADR 203's guard —
  `hasLivePresence` — and check whether `presence` is replicated anywhere; it is not, by design).
  Under any multi-writer topology, no peer can evaluate the current rule. Not fixable by the
  prereq lane — this is why ADR 325 makes claims hub-authoritative.
- ~~**`updateLane` is a blind full-row overwrite**~~ **Landed:** per-field UPDATE + `lane.updated` diff rows (ADR 325 prereq). (2026-08-25; falsify: read the UPDATE at
  `store/lanes.ts:242` — it sets every column from a merged object). Concurrent patches to
  unrelated fields clobber; non-ownership field changes (branch, scope, title, stakes…) emit no
  audit or event at all.
- **The insight substrate was a one-machine view** (2026-09-03, gap 3 of the residence-2 census;
  measured at `8b327be3` on the dogfood daemon: 4,953 `residency.*` audit rows, none stamped, while
  `deriveWakeMetrics` reads six of those verbs — so `musterd report`'s wake cost counted one
  machine). **Struck 2026-09-03** for the wake economy by [ADR 365](../decisions/365-the-ledger-kind.md):
  the six wake verbs cross as `ledger` events, appended to `audit` and projected into nothing, while
  every deciding reader of them stays pinned to rows the local node minted. **Struck 2026-09-03**
  for the rest by [ADR 371](../decisions/371-the-record-kind-and-the-rest-of-the-ledger.md):
  `tool_call_stats`, `seed_thread_entries` and the hub's `incident_reports` cross as `record`
  events; the `residency.*` remainder joins the ledger set. Falsify by pushing a
  `residency.host_suspended` row between two daemons — it lands on the receiver now, and the
  receiver's `hostAsleepMs` ignores it (`store/residency.test.ts`).
- **`audit` cannot be a correctness log** (2026-08-25; falsify: read `appendAudit`,
  `store/audit.ts:335` — it try/catches its own INSERT and logs a warning on failure). Contract
  is explicit ("best-effort observability, never a gate"); ADR 131 already ruled on it. This one
  is by design and stays — it disqualifies `audit` as the replication log, nothing more.

## Landscape survey (2025–26)

Surveyed 2026-08-25 for ADR 325's alternatives. Bottom line: the workload splits into commutative
append-only events and linearizable-CAS claims; every surveyed product optimizes exactly one half,
so none replaces sqlite-local + event-sync + authoritative-hub. External-world claims below carry
their source; re-check before reuse — this field churns fast.

- **ElectricSQL** acquired by Databricks 2026-08-11; cloud winding down, OSS pledged open
  ([announcement](https://electric.ax/blog/2026/08/11/electric-joining-databricks)). Their
  **Durable Streams** (MIT, single binary, append-only log over HTTP, replay-from-offset;
  [repo](https://github.com/durable-streams/durable-streams)) is the one candidate ADR 325 names
  for build-time evaluation as a sync *transport* — repo is ~9 months old.
- **PowerSync** — only serious replace-the-layer candidate: Node SDK forks better-sqlite3,
  server-authoritative writes ([docs](https://docs.powersync.com/client-sdk-references/node)).
  FSL-licensed, Node SDK in beta (2026-08-25; falsify: an independent production report of the
  Node SDK under a long-running daemon — none found).
- **NATS JetStream** — real revision-number CAS in its KV, but leaf-node sync of edge-originated
  writes is its weak spot ([nats-server#7530](https://github.com/nats-io/nats-server/issues/7530)),
  and it is a second stateful system.
- **CRDTs (Automerge/Yjs/Loro)** — healthy libraries, wrong primitive: a CRDT cannot express
  "exactly one holder". Empirical: the Cinapse migration off CRDTs
  ([PowerSync case study](https://powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync)).
- **Dead or misfit** (one line each, all as of 2026-08-25): cr-sqlite — no substantive core commit
  since 2024-01 ([repo](https://github.com/vlcn-io/cr-sqlite)); SQLSync dead, successor **Graft**
  ([repo](https://github.com/orbitinghail/graft)) is the right primitive (strongly-consistent
  partial replication) but pre-1.0 — re-evaluate ~2027; Turso sync is last-push-wins (destroys
  claims) amid platform churn ([roadmap](https://turso.tech/blog/upcoming-changes-to-the-turso-platform-and-roadmap));
  Litestream/LiteFS are DR/read-replica shapes; Zero 1.0 is a browser-app engine; Jazz mid-rewrite;
  Ditto closed + per-device pricing; Convex is a cloud backend (inverts the architecture);
  Cloudflare Durable Objects are a fine *hub* but cannot run on dev machines; KurrentDB left OSI
  licensing; "agent-memory" DBs (mem0 et al.) solve retrieval, not coordination; SQLite
  `BEGIN CONCURRENT` remains experimental-branch-only.
