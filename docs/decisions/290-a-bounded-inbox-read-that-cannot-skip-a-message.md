# 290 — A bounded inbox read that cannot skip a message

- Status: accepted
- Date: 2026-08-19
- Deciders: dolly (found it while measuring the starvation lane, built it), nick (asked for it to be
  taken)
- Relates to: ADR 287 (the cursor never passes what you did not see — this extends its rule across
  the fetch boundary), ADR 131 (the wake poll's hold time), ADR 088 (the interrupt line at the tool
  boundary), ADR 061 (the firehose's bounded backfill)

## Context

`GET /inbox` accepted `?limit=` but had no **default**. A caller that named none received every
message it had not read, in one reply. Found while measuring the event-loop starvation lane
(01M0DY2TBF5MCYDRAV05GXKF9C): after the wake poll and the interrupt line were bounded, this was the
last unbounded read left on the request path, and the last thing that could still hold the loop —
`/health` p99 116ms at 24k unread, against a 100ms bar the guardian reads as liveness.

The daemon is single-threaded over synchronous better-sqlite3, so an unbounded read is not merely a
large response: it is latency for every other request in flight, including the liveness probe whose
timeout produces false `daemon_down` alarms.

## Problem

The obvious fix is the dangerous one.

`listInbox`'s existing `limit` takes the **newest** n (`DESC + LIMIT`, then re-sorted). That is right
for "show me the recent tail" and catastrophic as a default. A seat with 5000 unread would be handed
the newest 200; a client that then advanced its read cursor to the newest message it received would
step over the other 4800 permanently. The cursor is a single watermark, so there is no per-message
state to notice the gap.

That is exactly the loss ADR 287 exists to prevent, arrived at from the other direction — through the
fetch rather than through the client's own slicing. A latency fix has no business introducing it.

There is a second, quieter version of the same problem. ADR 287 decides whether the cursor may
advance by comparing what a call rendered against what it received. Once the fetch itself is bounded,
**what it received stops being proof of what is waiting**: a full-looking page can sit on top of
thousands the request never returned, and elision derived from the page alone reads as zero.

## Decision

**1. A read that names no `limit` is bounded to a PREFIX, not a tail.**

`InboxOpts` gains `headLimit` — the *oldest* n — kept deliberately separate from `limit` rather than
folded into it as a flag. They answer opposite questions, and collapsing them would leave the
dangerous shape as the default spelling. A prefix is the only truncation where advancing the cursor
to the last row seen cannot skip anything: the response is what the caller would have received,
stopped early. Catching up takes several reads and reaches every message in order.

The default is 200 (`INBOX_DEFAULT_LIMIT`) — large enough that an ordinary check returns everything
waiting and never sees the flag, small enough that a deep backlog cannot hold the loop.

**2. An explicit `?limit=` is untouched.** That caller asked for the recent tail and still gets it.
This is also how a surface opts out of the prefix: see 4.

**3. The reply says what it could not carry.** `truncated: true` when the default bound cut the
response, and `unread_remaining: n` — counted, not marshalled, so it stays cheap on a deep backlog.
`listInbox` now honours `since` *alongside* `unreadOnly`, taking the later of the two floors, which
is what makes a bounded unread read pageable at all.

**Amended 2026-08-20 (#946): the title's claim was true of the BOUND and false of the CURSOR that
walks it.** Decision 1's argument — "a prefix is the only truncation where advancing the cursor to
the last row seen cannot skip anything" — is correct, and it silently assumes the position that
advances is total over the rows. It is not. `listInbox` orders by `ts ASC, id ASC` while the cursor
is a bare `ts`, so `id` is a declared tiebreak with no expression in the position. When a tie
straddled the page boundary, page two asked for `ts > last` and excluded every row sharing that
millisecond: measured at 220 messages, page one 200, page two **0**, the drain terminating on the
empty page and reporting success at 200 of 220. Not one skipped row — the whole tail, silently.

Worse one layer down: the read cursor is also a bare `ts`, so a message sharing the cursor row's
millisecond was not merely stranded mid-walk, it could never appear as unread again — the cursor
only moves forward. The cursor row already stored `last_read_message_id`; nothing consulted it.

The repair does not add a cursor field. `since` keeps its exact meaning, and the PREFIX BOUND is
made to never split a tie group — it completes the group past `headLimit` instead of cutting through
it — so `ts > last` is exact again for every caller, including one on an older client with no way to
send a tiebreak. Paying for that in a response occasionally larger than the bound is the deliberate
trade against a silent permanent hole. The unread floor and `countUnread` do take the `(ts, id)`
comparison, since the cursor is genuinely a point and both must agree about a tied row. Corrected
claim: **a bounded read cannot skip a message, because the bound never falls inside a tie and the
cursor compares as the pair the ordering is defined on.**

**4. Newest-first is preserved where a seat reads once a turn.** ADR 287 is explicit that an agent
checking at a task boundary must not be handed the stalest 50 and told the urgent ask is behind them.
So `team_inbox_check` now names its `limit` — it gets the newest tail it actually renders — and takes
its elision count from `unread_remaining` instead of deriving it from a slice that can no longer
prove anything. `planInboxCheck` gains an `unreachable` argument for exactly that, and holds the
cursor when it is non-zero. ADR 287's rule is unchanged; it now holds one layer further out.

**5. A client that promises everything must page.** `musterd inbox` documents that all unread are
always shown. It keeps that promise honestly by walking pages on `since` until `truncated` is absent
— and paging is what actually fixes the starvation, because each page is a bounded read the loop can
breathe between.

## Consequences

- No caller can be handed a truncated view and silently consume what it did not see — through the
  slice (ADR 287) or through the fetch (here).
- `/health` p99 at 24k unread: 116ms → 46-85ms over three runs, max under the 100ms bar. At 12k,
  p99 30ms. The lane's acceptance bar is met at every depth measured.
- A seat with a deep backlog now reaches its messages over several calls rather than one. That is a
  real behaviour change, and the right one: the alternative was one reply that blocked every other
  request on the daemon.
- Two spellings of "bound this read" now exist (`limit`, `headLimit`). The asymmetry is the point and
  is documented at the type; a future reader tempted to unify them should read the Problem section
  first.

## Observability & Evaluation

**Traces.** No new span. The existing `http_request` line already carries `path` and `ms`, which is
what the latency claim is read off; `seen_latency` (ADR 090) is unchanged, since the cursor route is
untouched. A bounded reply is visible in the response itself (`truncated`, `unread_remaining`) rather
than in telemetry, because the caller is the party that has to act on it.

**Eval.** Dataset: `scripts/perf/health-under-burst.mjs`, which seeds the shape production actually
has (measured on revive 2026-08-19: enrolled seats 0-65 unread and current cursors; never-reading
seats 4070 and rising) and replays the traffic mix the daemon really serves. Baseline: `/health` p99
116ms at 24k unread on b8a20c3b, the commit before this change. Target: p99 under 100ms at every
depth up to 24k. Measured after: 46-85ms over three runs.

**Experiment.** The safety half is not a statistical claim and is not evaluated as one — it is a
property, asserted directly: a bounded read whose first element is not the oldest unread fails
`inboxHead.test.ts`, and a `team_inbox_check` that advances the cursor while `unread_remaining` is
non-zero fails `inboxCheck.plan.test.ts`. The thing worth watching in the field is whether seats
start seeing `truncated` in ordinary use, which would say the 200 default is too low for how far
behind seats actually run; the counter is the flag's own presence in a reply.

## Falsifier

Run `SHALLOW=24000 ROUNDS=200 node scripts/perf/health-under-burst.mjs` on a quiet machine: `/health`
p99 above 100ms falsifies the latency claim. For the safety claim, a bounded `GET /inbox` whose first
element is not the oldest unread — or a `team_inbox_check` that advances the cursor while
`unread_remaining` is non-zero — falsifies the decision outright.

**Added 2026-08-20 with the amendment above, since the original falsifier could not fail under a
tie:** seed a backlog whose rows straddle the bound sharing one millisecond, walk it with `since`,
and count the ids reached. Reaching fewer than were sent — or an unread message sharing the cursor
row's ts not appearing in an `unread=1` read — falsifies the corrected claim. Both are pinned by
test (`integration.test.ts`, `inbox.test.ts`); every fixture in this area seeded `ts: Date.now() + i`
before this change, which is precisely why a strictly-increasing suite could report the property
green while it was false. A falsifier that cannot construct the failing case is not one.
