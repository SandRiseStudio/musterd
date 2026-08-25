# Federation data census

What each table in the daemon's store is (event, state, or ephemera), how writes actually happen, and what the 2025–26 sync/DB landscape offers — the fact base under [ADR 325](../decisions/325-multi-machine-federation.md).

All codebase claims measured 2026-08-25 at `3162aa16` (migrations at v44). The store evolves;
re-verify against `packages/server/src/db/migrations.ts` before leaning on a row below.

## Table classification

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

- **No global ordering primitive** (2026-08-25; falsify: find an `origin_seq`/HLC/logical-clock
  column in `migrations.ts` — there is none). Ordering is wall-clock `(ts, ULID)`.
  `store/residency.ts` tie-breaks on local `rowid` in two queries (~:596, :622), and
  `incident_reports` is the schema's only `INTEGER AUTOINCREMENT` id — both meaningless once rows
  originate on more than one machine.
- **Lane claim is a TOCTOU, not a CAS** (2026-08-25; falsify: read the lane PATCH handler,
  `transport/http.ts` ~:3115 — look for an enclosing `db.transaction` or a `WHERE
  owner_seat/state` guard on the write; neither exists). `getLane` → ~65 lines of JS policy →
  unconditional `updateLane`. The 2026-08-01 double-claim (lanes 01KYX8J5XD / 01KYXWNX9R, noted at
  ~http.ts:3133) is the recorded cost.
- **The claim's arbitration input is host-local** (2026-08-25; falsify: read ADR 203's guard —
  `hasLivePresence` — and check whether `presence` is replicated anywhere; it is not, by design).
  Under any multi-writer topology, no peer can evaluate the current rule. Not fixable by the
  prereq lane — this is why ADR 325 makes claims hub-authoritative.
- **`updateLane` is a blind full-row overwrite** (2026-08-25; falsify: read the UPDATE at
  `store/lanes.ts:242` — it sets every column from a merged object). Concurrent patches to
  unrelated fields clobber; non-ownership field changes (branch, scope, title, stakes…) emit no
  audit or event at all.
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
