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

## 2026-09-25 — demo audience, concurrent: the /live roster fan-out, and a ceiling of ~75 (lane 01M3D4069F)

The Oct 7 demo (goal `demo`) puts the audience on the team: attendees sign in as human members
over OAuth remote MCP from phones, may add an agent seat, and watch `/live`. `health-under-burst`
is sequential, so it cannot say what a room does to the daemon; the new instrument is
`scripts/perf/demo-audience-load.mjs`. It drives three concurrent populations (humans with
bearer-only tool calls every ~20 s, agents on the hook rail, `/live` viewers modelled on
`packages/web/src/live` — backfill, WS `team-all`, a roster refetch per presence frame, a `/report`
refetch per lane act), and it runs the daemon in a child process that reports its own event-loop
delay and CPU. Synthetic board: 1200 lanes with 1.8 KB `detail` each (`GET /lanes` 2.5 MB, as on
revive).

**Not on a laptop.** The first run was on the presenter-class laptop (M3, 8 GB, 8 cores, with the
live daemon and a dozen seats running). The load average reached 105. The daemon used 29 % CPU yet
stalled 7 s: it was starved by the machine, not saturated by its work, so that run measures nothing.
Every number below is from a throwaway Fly `performance-8x` (`scripts/perf/loadbench.fly.toml`,
sjc), with the daemon pinned to core 0 (`DAEMON_CPUS=0`) and the audience on cores 1-7. One core is
the budget, because Node serves the daemon on one thread. Each run is 120 s with arrivals ramped
over 30 s. The server was built from main at a02c2eb (#1711). The remote `/mcp` endpoint (ADR 446) has not
landed, so humans are modelled as the HTTP routes their tools call.

| N humans = agents = viewers | viewer roster rule | req/s | daemon CPU | loop p99 | all p95 | roster (viewer) p95 | roster body |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | every frame | 5.3 | 5 % | 15 ms | 61 ms | 70 ms | 19 KB |
| 25 | every frame | 20.5 | 14 % | 26 ms | 178 ms | 209 ms | 47 KB |
| 50 | every frame | 53.8 | 44 % | 122 ms | **7564 ms** | 7896 ms | 94 KB |
| 50 | coalesced | 32.6 | 27 % | 41 ms | **349 ms** | 412 ms | 94 KB |
| 75 | coalesced | 57.3 | 54 % | 172 ms | 801 ms | 884 ms | 140 KB |
| 100 | coalesced | 73.0 | 80 % | 500 ms | 1838 ms | 4948 ms | 186 KB |

**The bottleneck was the viewers, not the seats.** Every `/live` page refetched the full roster
(`GET /teams/:slug`) on every presence frame, and every viewer receives every frame. The cost was
viewers × presence events: at N=50 that was 4116 frames, 4166 roster fetches of 94 KB in two
minutes, and 64 % of all requests. It grows with the square of the room. The seats' own traffic
(interrupt-check, inbox, sends) stayed in single-digit milliseconds at p50 throughout.

**The fix** (`packages/web/src/live/coalesce.ts`): the first presence frame still refetches at
once, and frames arriving during that fetch, or within 1 s of its start, fold into one trailing
fetch. At N=50 roster fetches fall from 4166 to 1606 and p95 from 7.6 s to 349 ms. It is a
web-only change, so it reaches `/live` through the build-publisher without a daemon restart.

**Go/no-go for Rehearsal A: about 75 of each** (75 humans, 75 agents, 75 viewers) on one
dedicated performance core, with p95 under 1 s. At 100 of each, p95 is 1.8 s. The roster is still
the top cost there (186 KB per fetch, and the body grows with the room). The next levers, in
order: (1) apply presence frames to the roster in place and refetch only for a member the page has
not seen, which removes the fan-out rather than rate-limiting it; (2) a short server-side memo of
the roster response; (3) the 2.5 MB `/lanes` body (p95 1 s at N=100). The demo host is a separate
question, because a laptop running the presentation cannot give the daemon a quiet core — see the
lane's note to the public-route lane (`01M3AKNAW6`).

Falsify the fix: rerun N=50 with `ROSTER=every` on the same box and find p95 under 1 s.

## 2026-09-25 — the human rail moves to the released OAuth + `/mcp` path (harness change, numbers pending)

The table above modelled humans as the plain REST routes their tools call, because the remote
`/mcp` endpoint had not landed. It has now (ADR 446, #1694: Streamable HTTP at `/mcp/:team`,
per-seat OAuth), and the review hold on this lane is exactly that gap: benchmark evidence must
exercise the released path, not a model of it.

`demo-audience-load.mjs` now drives humans over the released rail by default (`HUMAN_RAIL=mcp`):
the OAuth leg on arrival — dynamic client registration → authorize (PKCE) → token, the phone's
sign-in, so the arrival burst now carries the OAuth write path — then MCP `tools/call` frames
(`team_inbox_check` / `team_send` / `team_join`) with the `msat_` bearer per call. The child
daemon runs `trustProxy` (the demo posture), and each loopback human presents what the Cloudflare
edge would: `x-forwarded-proto: https` and a distinct `cf-connecting-ip`, which is also the OAuth
rate-limit key — so the per-IP buckets behave as they would for a room of real phones.
`HUMAN_RAIL=rest` keeps the modelled shape for A/B against the table above.

The tunnel leg is `REMOTE_URL=https://<hostname>`: humans go loopback → cloudflared → the
Cloudflare edge → back while agents/viewers stay loopback (the demo tunnel's ingress only exposes
`/mcp` and OAuth paths — `docs/operations/public-demo-tunnel.md`). The loadbench image now carries
`cloudflared`; the run recipe is in `loadbench.fly.toml`. Caveat recorded there: through a real
tunnel the edge collapses every driven human onto the box's one IP, so tunnel runs measure
steady-state tool-call latency (arrivals stretched under the per-IP OAuth limits), and the
arrival burst is read from loopback runs, where the per-attendee rate key is faithful.

**Numbers (2026-09-25, loadbench `performance-8x` sjc, `DAEMON_CPUS=0`, 50/50/50, 90 s, ramp
30 s, synthetic board of 1200 lanes).** The released `mcp` rail costs the daemon *less* than the
modelled `rest` shape, not more:

| rail | all-req p50 | p95 | p99 | daemon CPU | rss | loop delay p99/max | errors |
| ---- | ----------- | --- | --- | ---------- | --- | ------------------ | ------ |
| `mcp` (released, OAuth arrival + tools/call) | 22 ms | 557 ms | 837 ms | 43 % | 211 MB | 81 / 754 ms | 0 |
| `rest` (modelled A/B) | 26 ms | 614 ms | 1776 ms | 46 % | 225 MB | 92 / 764 ms | 0 |

The OAuth arrival burst is absorbed cleanly at N=50 (register p95 79 ms, authorize p95 163 ms,
token p95 109 ms, per-attendee `cf-connecting-ip` rate keys under `trustProxy`). The `rest`
rail's worse tail comes from humans hitting `GET /lanes` (2.5 MB bodies) and `GET /teams/:slug`,
which the MCP tool surface never fetches — the released rail replaces big-body reads with small
`tools/call` frames. Both runs stay inside the p95 1000 ms budget; the dominant cost at N=50
remains the viewer roster fan-out (`GET /teams/:slug` p95 ~726-772 ms), unchanged from the
2026-09-25 section above, so the **go/no-go ceiling stays ~75 concurrent attendees** — the
released rail does not move it down.

**Still pending:** the `REMOTE_URL` quick-tunnel steady-state run (external-ingress tunnel was
not runnable from this session; recipe in `loadbench.fly.toml`, RAMP ≥ 12 s/human through the
edge).
