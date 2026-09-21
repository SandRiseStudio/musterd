# ADR 429: inbox pinning is an obligation rule, not a salience one

- Status: proposed
- Date: 2026-09-21
- Lane: 01M32FH5YQD4EVTG6ARSS0S0SG (goal `seat-continuity`, increment 2)

## Context

`GET /inbox` with a `limit` returns the newest `limit` unread **plus** a pinned set unioned on top,
so a bounded page cannot bury an act that is waiting on the reader (`listInbox`,
`packages/server/src/store/messages.ts`). The pin predicate is:

```sql
act IN ('request_help', 'ask') OR (to_kind = 'member' AND act NOT IN ('message', 'resolve'))
```

Its comment says it matches the CLI banner's `isActionNeeded`. It matches that predicate's *shape
test* and drops the narrowing that makes the CLI's version correct: the banner counts through
`openActionNeeded`, which additionally excludes a thread with a `resolve` on it and an act this seat
has already replied to — "the open-vs-done axis ADR 024's read-cursor deliberately doesn't track".
The server kept the salience half and used it as a **retention** rule.

Salience and retention are different questions. "Should this be visible above the fold right now"
tolerates a generous predicate: the cost of a false positive is a row of screen. "May this row be
dropped from a bounded page, forever, on every future read" does not: a false positive there is
permanent weight on every wake for as long as the act stays unread.

Measured on the laptop daemon, 2026-09-21 (lane 01M32FH5YQ, `~/.musterd/musterd.db`):

| seat | cursor last advanced | unread | pinned rows | pinned body |
| --- | --- | --- | --- | --- |
| stanley | 2026-07-16 | 8,526 | 370 | 327 KB |
| dolly | 2026-09-16 | 859 | 15 | 9.6 KB |
| miley | 2026-09-21 | 35 | 1 | 0.9 KB |

Stanley's 370 pinned rows, by act:

| act | rows | body |
| --- | --- | --- |
| accept | 129 | 121,847 |
| ask | 123 | 58,480 |
| request_help | 50 | 69,272 |
| status_update | 41 | 43,547 |
| decline | 13 | 16,709 |
| handoff | 9 | 10,857 |
| steer / challenge | 5 | 6,812 |

## Problem

Three defects compound, and only the first is the one the lane was opened for.

**1. The predicate pins answers as though they were obligations.** `accept`, `decline` and directed
`status_update` are the acts that *discharge* or *report on* an obligation; `wait` is a human saying
"deciding, check back"; `insight` is team memory. None asks the recipient for anything. They are
183 of stanley's 370 pinned rows and 182 KB of the 327 KB — pinned into every bounded read, forever,
because the predicate tests only "directed, and not `message`/`resolve`".

**2. The pinned union has no bound, so `limit` does not bound the reply.** `limit` binds the
newest-tail subquery only; the pinned `SELECT` beside it carries no `LIMIT`. `team_inbox_check
{limit: 8}` on stanley's seat returns 370 rows. This is the literal mechanism behind the lane's
"ignores `limit`".

**3. Open-vs-done is folded after marshalling, client-side.** The server computes `answered` and
`discharged` (doorbell clause 7 — answered / `lane_closed` / `read`) and ships them as id lists
*beside* the rows, so `planInboxCheck` can drop them from `isPinnedNeed`. Correct as far as the
rendered view goes, and it is why a seat does not *see* 370 acts. But the bytes are already on the
wire and already in the daemon's marshalling; the client's `RESULT_BUDGET` then discards most of
them. The work is done twice and paid for once too often.

The compounding effect is the treadmill lane 01M2GT874Y was opened to end, returning by a door that
lane did not close. That lane made the *digest* walk ordinary so a seat past its limit could drain.
It did nothing about the pinned set, which is precisely the part of a bounded page that never ages
out — so four seats (stanley, ghost, grokbot, compo) have cursors that have not moved in 38 to 67
days.

### What "read" means for a directed act

The ambiguity the lane asked to name. Two notions were doing one job:

- **Read** — the cursor passed it. A position, one per seat (`inbox_cursors.last_read_ts`),
  monotonic, and under ADR 287 it may never pass a row the call did not render.
- **Owed** — the act asks something of this seat that has not happened yet. Not a position: a
  per-act state, derived, and it can be discharged by an event elsewhere (someone else accepts, the
  lane closes) that the seat is not a party to.

Pinning exists to stop the *first* from losing the *second*: an obligation must not fall off the
bottom of a bounded page just because it is old. That is right, and this ADR keeps it. What went
wrong is that the pin predicate approximated "owed" with "directed and not chatty", which is not an
approximation of it at all — it admits every answer and every report, and those are exactly the acts
that accumulate.

## Decision

1. **Pin the obligation class, not the directed class.** The pinned set becomes: `request_help` and
   `ask` (whoever they are addressed to), plus `handoff`, `steer`, `challenge` and `defer` addressed
   to this member. An act outside that set is never pinned; it still reaches the reader through the
   ordinary newest-tail and the digest walk, and is still unread until the cursor passes it. The set
   is named once, in `@musterd/protocol`, and both the server's SQL and the MCP's `isPinnedNeed` are
   built from that one list.

2. **Bound the pinned set.** The pinned `SELECT` takes a `LIMIT`, oldest-first — an obligation that
   has waited longest is the one a bounded page must not drop. Rows past the bound are counted into
   `unread_remaining` like any other row the reply could not carry, so ADR 287's rule holds
   unchanged: the cursor still may not pass what was not rendered.

3. **Fold discharge before marshalling, not after.** The `answered` / `lane_closed` / `read`
   exclusions the server already computes are applied to the *pinned* selection before its rows are
   loaded, so a discharged obligation costs nothing rather than costing a row the client then drops.
   The `answered` / `discharged` id lists stay in the response unchanged — the CLI and older clients
   read them, and they remain the honest record of *why* an act stopped being owed.

**Not decided here.** The digest walk, the `RESULT_BUDGET` split, the second prefix round trip a
behind seat pays, and the resume bound (increment 1, ADR 427) are all untouched.

## Consequences

- A caught-up seat is unaffected: nothing is pinned, and the reply is the "no new messages" line.
- A behind seat pays for its obligations and not for its backlog's answers. Measured on the laptop
  daemon's own database, pinned rows returned for a bounded read, before → after:

  | seat | unread | before | after |
  | --- | --- | --- | --- |
  | stanley | 8,526 | 370 rows / 319.8 KB | 50 rows / 30.1 KB |
  | ghost | 9,012 | 183 rows / 159.6 KB | 50 rows / 21.0 KB |
  | grokbot | 7,735 | 116 rows / 93.3 KB | 50 rows / 21.2 KB |
  | dolly | 859 | 15 rows / 9.4 KB | 4 rows / 2.7 KB |
  | miley | 35 | 1 row / 0.9 KB | 0 rows |

- What survives is real. Stanley's 370 fall to 81 genuinely-owed acts (63 `ask`, 8 `request_help`,
  7 `handoff`, 3 `steer`), of which only 6 are acceptance asks on lanes that have since closed. The
  remaining weight on that seat is 67 days of unanswered obligations, which is a team fact and not a
  bug — and the point of the pinned set is that it keeps reporting it.
- **Known, not fixed here (2026-09-21):** on a seat with tens of owed acts the pinned set can still
  fill the MCP's `SHOWN_BUDGET` (21k of the 30k `RESULT_BUDGET`) on its own, leaving the digest
  little room and so draining the backlog slowly. That is the budget SPLIT, not the pin rule — a
  client-side change with its own risk, on a surface this ADR deliberately does not touch. Recorded
  here so the next reader does not mistake a slow drain for this fix having failed.
- **`limit` becomes true.** It was documented as the escape hatch from the treadmill and named in the
  runtime notice; it has never worked on a seat with pinned rows, which is every seat the notice was
  written for.
- A directed `status_update`, `accept`, `decline`, `wait` or `insight` can now fall behind a bounded
  page. That is the deliberate trade and it is bounded by the digest: the walk renders the oldest
  unread contiguously, so such an act is *seen* (id, sender, act, body head) on an ordinary check
  rather than pinned above the fold on every check. The acts that may never be lost — the ones that
  ask something of the seat — are exactly the set that stays pinned.
- Falsifier: a `request_help`, `ask`, `handoff`, `steer`, `challenge` or `defer` that is unread,
  undischarged, and absent from a `team_inbox_check` reply that reported `elided_unread: 0`.

## Observability & Evaluation

- **Traces:** none added. This changes which rows a read selects, not what it records; the response's
  `answered` / `discharged` id lists and their `reason` labels are unchanged, so the doorbell
  contract's existing account of *why* an act stopped being owed still reads the same.
- **Eval:** the dataset is the daemon's own message log (`~/.musterd/musterd.db`, 5 enrolled seats,
  26k messages), and the measure is the pinned row count and body bytes a bounded read returns per
  seat — the query in Context reproduces it. **Baseline, 2026-09-21:** stanley 370 rows / 319.8 KB,
  ghost 183 / 159.6 KB, grokbot 116 / 93.3 KB, dolly 15 / 9.4 KB, miley 1 / 0.9 KB, at any `limit`.
  **Bar:** pinned rows `≤ pinnedLimit` for every seat, and no act of the obligation class missing
  from a reply that reported `elided_unread: 0`. Post-change on the same dataset: 50 / 30.1, 50 /
  21.0, 50 / 21.2, 4 / 2.7, 0.
- **Experiment:** the question this cannot answer is whether a lighter inbox makes a seat *orient*
  better — bytes are not comprehension. That needs the two-seat wake-life re-measurement this lane
  owes (acceptance (d)), recorded on `docs/wiki/resume-bound-is-below-one-wake-life.md`, and even
  that measures the life and not the reading of it.
