# Daemon load — measurement log

Probe: `node scripts/perf/health-under-burst.mjs` (`SEATS`, `ROUNDS`, `CLAIMS=0|1`) — a real server on
a seeded in-memory DB, the production request mix, and a `/health` prober whose p99 is what the
guardian experiences. Plus, when a live number is needed, the daemon's own `http_request` log lines
(`~/.musterd/daemon.log`, JSON, `ms` per request). Append a section per measurement; never rewrite
an old one. Lane `01M3AGPSCD125CTJA3RE7XX6VY`.

## 2026-09-24 — the ~95% CPU saturation was one query, not the write path

**The lane's window, from the daemon log (12:50–13:15 PDT, build 87a3645, ~12 seats, before v71).**
3221 requests. Three endpoints held the event loop for ~1135 s of the 1500 s window:

| endpoint | calls | avg | max | >1 s |
| --- | --- | --- | --- | --- |
| `POST /residency/wake-leases` | 98 | 7.6 s | 22.7 s | 98 |
| `GET /lanes` | 39 | 5.9 s | 29.1 s | 16 |
| `GET /report` | 10 | 16.4 s | 21.9 s | 10 |
| `GET /inbox` | 1669 | 48 ms | 5.1 s | 15 |

`/inbox` was 52% of requests and cheap; its 5 s max is queueing behind the three above. All three run
`openDirectedLedger`, whose discharge clause could not use an index — fixed by migration v71 (#1688,
[wiki](../wiki/sqlite-expression-index-affinity.md)). The guardian's stack sample
(`Statement::JS_run → vdbeCommit → pagerWalFrames`) was misleading as a diagnosis: a WAL commit is
where a write *lands* while a long read holds the checkpoint off, not what was slow.

**The same daemon after v71 (30 min ending 14:20 PDT, build 30f03da, 2004 requests, ~10% CPU):**
p50 19 ms · p90 39 ms · p99 499 ms · max 1.17 s · 5 requests over 1 s. `/health` answers in
8–22 ms. By endpoint: `/inbox` 1218 calls avg 26 ms; `wake-leases` 64 avg 157 ms; `/lanes` 11 avg
643 ms; `/sync/pull` 8 avg 823 ms; `PATCH /lanes/:id` 4 avg 871 ms.

**The write path is not the cost.** On a copy of the live DB (232 MB, `audit` 228k rows), one
single-row `audit` insert in its own transaction commits in **0.026 ms** under `synchronous=NORMAL`
— which is what the daemon already runs (SQLite reports `1`; nothing in `open.ts` sets it, the
build's default is NORMAL for WAL) — 0.080 ms under FULL, 0.004 ms/row when 300 share a
transaction. The live write rate is ~4200 `audit` rows/h and ~130 messages/h: under a second of
commit time per hour. The rows are dominated by CLI re-claims (`claim.occupied` ~500/h, bursts of
109/min at 14:12, 344/h from one Cursor seat's hooks), each ~6 audit rows plus a presence
attach/detach. That churn is a roster-noise question, not a latency one.

**The harness, repaired and extended.** It had been sending the retired `x-musterd-seat` +
agent-key identity (the wall 1d, 2026-09-23) and every request 401'd — its "p99 100 ms FAIL" was 60
rounds of auth refusals. It now mints a seat credential, a Presence and a session lease per
synthetic seat, as `/claim` would, and `CLAIMS=1` (default) re-claims a seat every third round with
the lease refreshed from the response (a re-claim supersedes the old one, as a CLI hook does to a
session in production).

| seats | mix | load / round | `/health` p50 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| 12 | read + probe + wake poll | 321 ms | 3.0 ms | 12.7 ms | 12.7 ms |
| 100 | read + probe + wake poll | 473 ms | 4.9 ms | 17.3 ms | 17.3 ms |
| 12 | + CLI re-claims | 659 ms | 4.2 ms | 24.3 ms | 25.9 ms |
| 100 | + CLI re-claims | 1046 ms | 8.6 ms | 42.1 ms | 42.1 ms |

Budget 100 ms, all green. "Will not survive 100 agents" is not supported for this mix on this build;
the harness is sequential (one request in flight), so it measures loop hold per request, not
throughput under concurrency — a concurrent variant is the next instrument if that claim needs
testing.

**Per-request cost on the live copy (quiet machine, second request after warm-up):**

| endpoint | wall | SQL | statements | the cost |
| --- | --- | --- | --- | --- |
| `GET /lanes` | 267 ms | 131 ms | 156 | `SELECT * FROM lanes … ORDER BY created_at` runs **16×** per request (116 ms); 2.5 MB response |
| `GET /report` | 239 ms | 160 ms | 2899 | per-lane / per-act fan-out: 342 `interrupt.raised` counts, 341 `answerBy` |
| `GET /inbox?unread=1` | 22 ms | 17 ms | 19 | fine |
| `GET /next/summary` | 5 ms | 1 ms | 12 | fine |

**Levers, ranked by measured value.** (1) Done: v71. (2) `/lanes`: read the table once per request
— `listLanes` is called from the handler and again inside `staleness`, contention (`lanes.ts:938`,
per lane), `goals`, `incidents`; a request-scoped memo removes ~110 ms and the 2.5 MB body wants
`detail` trimmed or paged. (3) `/report`: the 2899-statement fan-out. (4) Not worth doing on this
evidence: `synchronous`, batching writes, a worker thread for SQLite — the write path costs under a
second an hour. (5) The CLI re-claim churn is a roster/attestation-noise problem (every hook
invocation records `claim.occupied` + `superseded`), to be judged there, not here.

Falsify the headline: rerun the lane window's request mix against build 30f03da and find any
endpoint over 1 s that is not `/lanes`, `/sync/pull` or `PATCH /lanes/:id`.

## 2026-09-24 — `GET /lanes` reads the board once (lane 01M3ANEQVR)

`listLanes` was reached from the handler, then again from `boardWarnings` → `laneWarnings` for
**every** lane with a scope (the contention pass), and again from `staleLaneWarnings`. The handler
now reads the board once and passes it down; `filterLanes` derives the `?mine=1` / `?state=` view
in memory; `laneWarnings` takes the board as an optional last argument (the single-lane callers on
open/claim/update still read for themselves).

Same profiler, same live copy, median of 5:

| endpoint | before | after |
| --- | --- | --- |
| `GET /lanes` — table reads | 16 | 2 |
| `GET /lanes` — SQL | 131 ms / 156 stmts | 32 ms / 16 stmts |
| `GET /lanes` — wall | 267 ms | 210 ms |
| `GET /lanes?mine=1` — wall | — | 80 ms |

What is left of the 210 ms is not SQLite: `rowToLane` over 1218 rows (JSON-parsing `scope` and
`detail` per row) and serialising a 2.5 MB body. That is the body-size call the lane defers — page
the list, or drop `detail` from it (the CLI and /board read it) — and it is where the next 150 ms
are. One more read of the table remains on the path (8 ms), from a helper that was not traced to
its caller; not worth chasing at that size.
