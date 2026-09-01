# 349 — Read cursors walk receipt order, not the sender's clock

- Status: proposed — 2026-09-01
- Date: 2026-09-01
- Lane: `01M1FAYTHQA881M35PDPXRTGM1`

## Context

Every message carries two clocks. `ts` is the **origin's**: the sending process stamps it
(`makeEnvelope` defaults it to the client's `Date.now()`), and ADR 335 has it travel unchanged
through the sync log so a folded event says when it was said. `created_at` is **this daemon's**:
the instant `insertMessage` or `foldBatch` wrote the row. On one machine with well-behaved clients
the two agree to the millisecond, and nothing distinguished them.

Every read cursor keyed on `ts`. `inbox_cursors.last_read_ts` stored the cursor row's `ts`;
`listInbox`, `countUnread`, `listInterruptCandidates`, the delivery ledger's seen predicate,
`crossedBySeen`, `slowestInboxLagMs` and the wake queue's work-order reads all compared or ordered
by it (ADR 290 fixed the millisecond tie on that key; it did not question the key).

Federation increment 3b-ii (spec §"The ts-cursor defect", second-read by ryder 2026-09-01) makes
the two clocks disagree as a matter of course: a remote event folds into `messages` after ordinary
sync lag, carrying a `ts` from before the local seat last read. Keyed on `ts`, that event is below
the cursor the moment it lands. It is not shown late — it is never shown, because the cursor only
moves forward. The same shape needs no federation: a local client with a skewed clock produces it
today.

## Problem

Make every unread, interrupt and backlog read surface an event that arrives after a seat last read,
whatever clock the event's sender was on — without rewriting `ts` (ADR 335 has it travel for a
reason) and without a parallel sync-time column (ADR 331's two-sequences hazard, for nothing the
existing column does not give).

## Decision

1. **The cursor is a position in receipt order.** `inbox_cursors.last_read_ts` holds the cursor
   row's `created_at`. The column keeps its name; renaming it is a migration for no behavioural
   gain, and its doc comment now says what it holds. `setCursor` takes only a message id and reads
   the position off the row itself — a caller may say which row, never what clock.
2. **Every cursor-keyed reader compares and orders on `created_at`.** `listInbox` (filter, order,
   the `since` paging floor and the tie-group completion), `countUnread`,
   `listInterruptCandidates`, the delivery ledger's `seen`, `crossedBySeen`'s window,
   `slowestInboxLagMs` (floor and age — how long *this daemon* has held it unread is the only age it
   can vouch for), and the wake queue's `dueReviewWorkOrders` / `dueDispatchHandoffWorkOrders`.
   The tiebreak on `id` (ADR 290) is unchanged.
3. **The envelope carries the position, additively.** `Envelope.received_at` (optional) is the
   serving daemon's `created_at`, set by `rowToEnvelope` on every read path — inbox, history, live
   delivery. `envelopePosition(env)` is `received_at ?? ts`: a client compares *that* against
   `cursor.last_read_ts` and pages `since` by it. The fallback is the pre-fix comparison, correct
   whenever nothing arrived out of order, so a new client against an old daemon degrades to today.
   The sync push strips `received_at` for the reason `created_at` never travelled: the hub stamps
   its own on fold, and shipping ours would assert when the hub learned of the event.
4. **`ts` keeps every meaning that is about the sender.** Loop and seen latency measure from it;
   steer supersession, deferral ordering and "first answer" reads stay on it; history backfill
   (`GET /messages?since`, ADR 061) is unchanged in this increment and is noted below.
5. **Migration v53** indexes `messages(team_id, created_at)`. Nothing indexed it; every inbox,
   interrupt-check and unread-count read now scans by it.
6. **Tests inject the receipt clock.** `insertMessage(…, { now })` stamps `created_at` for fixtures
   that need two rows in one millisecond or one that arrives an hour after it was stamped — the same
   shape as `slowestInboxLagMs(db, now)`. Production callers leave it unset.

## Consequences

- The falsifier the spec wrote before any reader moved is now a test
  (`store/cursorReceiptOrder.test.ts`): an event stamped one hour below a seat's cursor, inserted
  after it, is unread in the listing, the count, the interrupt window, the ledger, the gauge, and is
  crossed by the next cursor advance. Red on the ts-keyed readers, green on all of them moved.
- The inbox lists in receipt order. On one machine with honest clocks this is the order it always
  was; a late arrival now sits where it arrived rather than being spliced into the past — which is
  also the only order a forward-only cursor can walk without loss.
- An **old client against a new daemon** compares `ts` against a `created_at` cursor. Locally the
  two agree to within the insert latency, so the visible effect is nil; a late-arriving remote event
  is shown by the daemon but may render without the unread marker until the client updates. The
  daemon's answer is the authoritative one and it is now right.
- `GET /messages?since` (history backfill for the dashboard) still walks `ts` and has the same
  defect for a firehose reader. It is not a cursor a seat's obligations ride on, and its consumer is
  the web dashboard's catch-up; it moves when that surface is next touched, and this ADR names it so
  the omission is a decision rather than an oversight.
- The federation enrollment lane (3c and after) may carry this lane as a met `depends_on`: the
  precondition the spec set on the second machine is discharged.

## Observability & Evaluation

- Traces: `musterd.coordination.seen_latency` (ADR 090) is unchanged in meaning — its bounds are
  cursor positions, its measured latency is send→seen from the envelope's `ts`.
- Eval: the server store and transport suites are the dataset. Baseline (main before this lane):
  the falsifier's five reader assertions fail; every other test passes. Post-change: all 1280 server
  tests pass, including the ADR 290 tie tests re-pinned to receipt order, and 506 MCP + 2124 CLI
  tests with the clients moved to `envelopePosition`.
- Experiment: none needed beyond the falsifier. The first real observation comes free with the
  second enrolled machine — the pull loop's folded events surfacing as unread on the joiner.
