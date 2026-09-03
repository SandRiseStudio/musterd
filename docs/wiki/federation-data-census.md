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
| `audit` — `policy.change` | 1 | `appendReplicatedEvent` via `applyPolicyChange` (hub only); fold projects onto `teams.policy` | **yes** (2026-09-03, ADR 365) | the fourth replicated kind; exempt from residence binding at ingest — the hub mints it on a joiner admin's behalf |
| `audit` — everything else (`residency.*`, `seat.*`, `memory.*`, `claim.*`, `incident.*`, `ask.*`, `handoff.*`, `git.pr_merged`, …) | 2 ("the audited verbs") | `appendAudit`, best-effort, `origin_seq = 0` — never selected by `unpushed` | **no** | a stamped row of any other action would poison the fold (`unknown_lane_event`); widening the filter alone is unsafe |
| `lanes` | 1 | projection of folded `lane.*`; hub-authoritative CAS for every ownership/state patch | **yes** (as events) | field edits (title, scope, branch) stay local-authoritative and replicate as `lane.updated` |
| `presence` | 3 → 2 (transitions) | folded rows carry `node`; heartbeats/grace/`conn_id` local | **yes** (transitions) | liveness of a remote row = its node's `last_seen_at` |
| `seat_nodes` | hub decision input | hub-minted (ADR 355 §5, 358) | n/a — hub-only by design | a joiner asks, never reads it |
| `nodes` (liveness) | hub | `upsertForeignNode` on the pull summary | **yes** (identity + `last_seen_at`) | credentials never leave the hub |
| `teams.policy` | 1 (admission/policy is hub-authoritative) | hub `POST /policy` → `applyPolicyChange` (stamped); a joiner forwards to `POST /sync/policy` and writes nothing; fold applies the sparse doc with replace semantics | **yes** (2026-09-03, ADR 365 — GAP 1 CLOSED) | the 21 readers incl. `claimWakeLeases` now agree across machines after one tick. An unreachable hub refuses `hub_unreachable`. Falsify: `sync/policy.test.ts`; `census.test.ts` also pins that raw `setPolicy` still ships nothing |
| `seat_memory` | 2 (LWW blob, named in the baseline) | local UPSERT | **no** — GAP | a seat that moves machines (ADR 358 trust) reads no memory there. Falsify: census test "seat memory and the inbox cursor are per-machine" |
| `inbox_cursors` | 2 (monotone max, promised explicitly) | local UPSERT | **no** — GAP | a human on two machines re-reads on each; same falsifier |
| `tool_call_stats` | 2 (additive counters, promised explicitly) | local UPSERT | **no** — GAP | insights (`report`) count one machine only |
| `seed_thread_entries` | 2 (promised explicitly) | `appendThread` in `store/seeds.ts`, unstamped | **no** — GAP | seeds themselves converge through the Slack relay on every daemon (`startSeedsIngest` runs unconditionally, `index.ts:181`); the *thread* a seat writes on one machine stays there |
| `seeds` (lifecycle) | 2 | relay-ingested per daemon; state moves local | partial — the relay, not the hub | two daemons can move one seed differently; not re-measured here |
| `wake_turns` | 2 (promised explicitly) | `appendWakeTurn`, lease-scoped, unstamped | **no** — GAP, but see note | a wake runs where the seat is enrolled (ADR 361 correction); its turns are read only by that host's report path. Cross-machine *cost* insight is the loss, and that is the unstamped `residency.wake_cost` verb above, not this table |
| `incident_reports` | 2 | local ULID rows (v45) | **no** — GAP | a blocked report on a joiner never reaches the hub's incident routing |
| `requests`, `grants`, `session_leases`, `agent_bootstrap_credentials` | 3 / local secrets | local | no, by design | short-TTL or credential-bearing |
| `residency`, `wake_leases`, `host_liveness`, `footprint_*`, `sync_*`, `local_node`, `schema_meta` | 3 | local | no, by design | ADR 325 residence 3; the wake ledger is derived from `messages` on the host's poll, so a folded act still wakes (wake-leases.md, 2026-09-03) |
| `members`, `roles`, team/seat identity | D (git) | projection from `.musterd/*.toml` | via git | unchanged |

**What the push selects, verbatim** (`sync/push.ts` `unpushed`, 2026-09-03): every `messages`
row and every `audit` row with `origin_node = <this node>` and `origin_seq > cursor`. There is no
action filter on the audit side — the *stamp* is the filter, and only `appendReplicatedEvent`
stamps. The action *prefix* picks the wire tag (`presence.` → `presence`, `policy.` → `policy`,
otherwise `lane`), and the hub and fold branch on the tag, never on the prefix. Falsify: stamp a
verb with none of those prefixes and push; the hub stages it and the joiner's fold stops at
`unknown_lane_event`.

### Gaps, ranked, with the lane each needs

1. ~~**`teams.policy`**~~ — **closed 2026-09-03 by [ADR 365](../decisions/365-team-policy-is-the-hubs-and-replicates.md)** (lane `01M1JNXSV7`), exactly as shaped here: a joiner's `POST /policy` forwards to the hub, the hub's `policy.change` is stamped, and the fold applies the sparse doc. Two things the shape learned in the building: the event carries the **stored** doc, not the effective one (shipping defaults would kill the schema default on every peer — ADR 185's #530 failure, replicated), and the policy kind is **exempt from residence binding**, or setting policy from a laptop would bind the admin's seat to the hub.
2. **Per-seat continuity: `seat_memory` + `inbox_cursors`** — both promised, both LWW/max-merge
   trivially; they matter the moment ADR 358 lets a human hold two machines. One lane, two tables.
3. **Insight substrate: `tool_call_stats` + the unstamped `residency.*` cost/lease verbs +
   `incident_reports` + `seed_thread_entries`** — nothing here decides anything; all of it makes the
   report and the ledger one-machine views. The audit half needs a *typed* replicated kind (the fold
   must know what to do with a verb it has never projected), not a filter widening.

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
  every deciding reader of them stays pinned to rows the local node minted. Still standing for
  `tool_call_stats`, `incident_reports`, `seed_thread_entries`, and the `residency.*` verbs outside
  the wake economy — falsify by pushing a `residency.host_suspended` row between two daemons and
  looking for it on the receiver.
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
