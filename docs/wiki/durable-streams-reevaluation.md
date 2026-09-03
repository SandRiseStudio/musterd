# Durable Streams re-evaluation

ADR 325's "re-evaluate if our own sync plumbing grows past a few hundred lines" trigger tripped; measured 2026-09-03, the answer is keep ours, and this page says why and what would change it.

## The trigger, measured (2026-09-03 at `17706ff9`)

ADR 325 §Alternatives named Electric's Durable Streams as a candidate sync *transport* "if our own
offset/retry/backfill code grows past a few hundred lines." Line counts of the sync surface,
tests excluded:

| file | lines | what it is |
|---|---|---|
| `sync/push.ts` | 449 | the joiner's push loop: `unpushed` query, batch, 403/409/422 handling, the wedge record |
| `sync/pull.ts` | 278 | the pull loop: fetch page or read staged, fold, per-stop error lines |
| `sync/log.ts` | 305 | hub ingest: team check, residence binding, origin rules, gap/replay, `sync_log` staging |
| `sync/fold.ts` | 1,035 | the fold: six kinds, six projectors, stop shapes |
| `sync/claim.ts` | 609 | hub arbitration of ownership edges (the CAS), enrollment lookup |

Push + pull + log is **1,032 lines** — past "a few hundred." But roughly a third of those lines are
comments, and of the rest most is **policy the transport cannot carry**: the ingest's residence
binding (ADR 360), the policy/record origin rules (ADRs 367/371), the team-name check, the
classified refusals the pusher turns into a persisted wedge (ADR 360 follow-on). The
offset/retry/backfill part ADR 325 meant — cursor, dense per-origin sequence, gap detection,
replay skip, batch bound — is on the order of 200–300 lines across the three files. Falsify: strip
the comment lines and the residence/origin blocks from `log.ts` and `push.ts` and count what is
left; if it is over 500, this paragraph is wrong.

## What Durable Streams is now (2026-09-03; falsify: re-read the linked sources)

- MIT, "Beta" badge, 1.7k stars; Node reference server, a Caddy plugin, and since 2026-06-26 a Rust
  server ("nearly a million operations per second on a single 4vCPU machine"). Clients in ten
  languages. [Repo](https://github.com/durable-streams/durable-streams).
- Electric was [acquired by Databricks on 2026-08-11](https://electric.ax/blog); "everything we've
  open sourced stays open source." Maintenance is a Databricks promise now, not a startup's.
- The protocol ([PROTOCOL.md](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md))
  has an idempotent-producer triple — `Producer-Id`, `Producer-Epoch`, `Producer-Seq` — where a
  duplicate seq answers 204 and the server serialises per `(stream, producer)`. That is our
  `(origin_node, origin_seq)` pair, one to one. Offsets are opaque, lexicographically sortable
  tokens (ULIDs in practice); reads are catch-up, long-poll, or SSE from an offset. There is **no
  conditional append / CAS**, and authentication is "explicitly out of scope."

## What it would replace, and what it cannot

It maps cleanly onto the *dumb* half: a stream per team is `sync_log`; the hub's `hub_seq` is the
offset; a push is an idempotent append with our pair as the producer triple; a pull is a read from
the cursor, and long-poll would replace the 60 s poll (`SYNC_PULL_INTERVAL_MS`). Perhaps 250 lines
of ours go, and sync latency drops from a minute to a round trip.

It cannot carry the half that makes the hub the authority:

- **Residence at ingest** (ADR 360) refuses a whole batch when any event speaks as a seat bound to
  another node. DS append is unconditional and unauthenticated by spec; the check would have to
  live in a proxy in front of it — which is `ingestBatch`, kept.
- **Origin rules** — a `policy.change` (ADR 367) or `record.incident_report` (ADR 371) is
  admissible only on the hub's own loopback. Same proxy.
- **The claim CAS** (ADR 355/361) is a separate surface DS never touched; ADR 325 said so.
- **Six projectors** (`fold.ts`) are ours whatever carries the bytes.

So the honest shape is "Durable Streams behind our ingest proxy," which keeps `log.ts` and most of
`push.ts`, replaces the storage of `sync_log` and the polling, and adds a second process (or the
Caddy plugin) to every hub. On a laptop hub that is a real cost for a latency win nobody has asked
for; on a hosted hub it may be the right storage. Falsify: an ask or status complaint naming sync
lag as the blocker.

## Verdict

**Keep ours.** The trigger fired on a number that mostly counts policy, and the policy is the part
that would survive the swap. Revisit when either of these is true:

1. The hub is hosted (ADR 325's Postgres/Durable-Object case) — then DS's Rust server or the Caddy
   plugin is a candidate for the hub's *log store*, evaluated against Postgres in that ADR.
2. Sync latency becomes a measured complaint — then long-poll on our own `GET /sync/pull` is the
   cheaper first move (it is one `AbortSignal.timeout` and a wait on the hub), before a new process.

Related: [federation data census](federation-data-census.md) (the landscape survey this updates),
[sync push](sync-push.md), [node enrollment](node-enrollment.md).
