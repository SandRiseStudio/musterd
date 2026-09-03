# ADR 366: Seat continuity replicates — and the note crosses with its body

- **Status:** Accepted (2026-09-03)
- **Lane:** `01M1JNY14F`
- **Closes:** residence-2 census gap 2 (`docs/wiki/federation-data-census.md`)
- **Supersedes in part:** ADR 093 §Audit hard rule 5 ("sizes only, never content")
- **Related:** ADR 325 (residence 2, promised), ADR 358 (a human on two machines), ADR 361 (the
  `/sync/lane` shape), ADR 367 (the policy kind, and what a residence exemption costs)

## Context

`seat_memory` and `inbox_cursors` are the two tables that exist to carry a seat across a gap: the
note a seat leaves itself at close ("where I left off, what is mid-flight"), and the point in the
inbox it has read to. ADR 325 named both residence 2 — memory an LWW blob, the cursor a monotone
max — and shipped neither. The residence-2 census measured the result: both were local UPSERTs with
no stamp, and a human who trusts a second laptop (ADR 358) found no note there and re-read an inbox
already read. The one thing seat memory exists to do, it did not do the moment there were two
machines.

Two facts about the tables shaped the design more than the census did.

**The cursor's number is not portable.** `last_read_ts` is the cursor row's `created_at` — this
daemon's receipt clock for that message — not the envelope's `ts` (lane `01M1FAYTHQ`, the ts-cursor
defect). The same message has a different `created_at` on every machine that folded it. So the
"monotone max" ADR 325 promised is only sound *within one daemon*; max-merging the raw number across
machines moves a cursor to a clock no local row carries and silently swallows the unread acts in
between — the ts-cursor defect again, now federated.

**Replicating the note means the audit log holds the note.** Every replicated kind rides the audit
table with an origin stamp (ADR 335 §8: one allocator). ADR 093 hard rule 5 says of `memory.save`:
"Sizes only, never the content: the audit log is not a copy of the note" — enforced verbatim in
`http.ts`. And ADR 093 calls the blob history-less, while audit rows are forever. Shipping the body
overturns the first and gives the lie to the second. Shipping a headline preserves both and is
arguably not continuity at all: the second machine learns a note exists and nothing of what it says.

That question was raised to nick as ask `01M1JS1PXH0NPZBPPS6V2WYTHY` rather than decided on a stated
invariant. He chose the body.

## Decision

**A seat's memory and inbox cursor replicate as a fifth kind, `continuity`; the memory event carries
the note's body; the cursor event carries a message id and never a timestamp.**

1. **A fifth replicated kind, `continuity`**, in the lane event's shape under its own tag, with three
   verbs: `continuity.memory_saved`, `continuity.memory_cleared`, `continuity.cursor_advanced`. The
   writers are `applyMemorySave` / `applyMemoryClear` (`store/memory.ts`) and `applyCursorAdvance`
   (`store/cursors.ts`), each writing the row and its `appendReplicatedEvent` stamp in one
   transaction. `saveMemory` / `clearMemory` / `setCursor` stay as they were — the fold's projector
   primitives, deliberately silent, the shape ADR 367 set for `setPolicy`.
2. **The memory event carries the body** — `detail: { headline, body, saved_at }`. Two consequences,
   stated here rather than discovered: the audit log now holds memory bodies, **daemon-side only,
   never git** (the ADR 058 line is unmoved — nothing in `.musterd/` changes), bounded by the 8 KiB
   cap `saveMemory` still enforces; and a blob ADR 093 called history-less has an implicit history
   in that log. The `memory.save` / `memory.clear` verbs write nothing now; the union keeps them so
   old rows still type.
3. **Memory is last-writer-wins on the ORIGIN's clock.** The event's `saved_at` is compared against
   the local row's; an older event applies as a no-op, never as a stop. One clock per fact, the
   origin's — the rule ADR 335 sets for `ts`, and the only one that survives two wall clocks that
   disagree by more than the gap between two saves.
4. **A clear is a fact with a clock, not an absence.** `continuity.memory_cleared` carries
   `cleared_at`; the fold deletes unless a local save is *newer* than the clear. Without this, a note
   a seat deliberately dropped walks back in from the next peer that still holds it. The event is
   written even when nothing was here to clear (`had_memory: false`), because the peer may hold a
   note this daemon has not folded yet.
5. **The cursor event carries `last_read_message_id` only.** The receiver resolves the id against
   its OWN `messages.created_at` and takes the max of that and where the cursor already sits — a
   place in the log, re-read locally, which is what a cursor has always been. An event naming an
   earlier place is a no-op, not a conflict.
6. **A cursor naming a message not folded here yet stops the fold** (`cursor_unborn`), retried each
   tick — the same block-don't-skip discipline as `lane_unborn` and `presence_unborn`. Skipping would
   leave the cursor at a position this daemon cannot resolve; the next tick has the message.
7. **Residence applies.** Continuity events are seat facts, minted wherever the seat is working, so
   the ingest binding is exactly the one messages and lanes get: a node may stamp continuity only
   for seats resident on it, and a forged `memory_saved` from a second enrolled node is refused
   `bound_elsewhere` with `kind: 'continuity'`. This kind needed **no** exemption and **no** origin
   rule of its own — the contrast with ADR 367's policy kind, where opting out of residence had to
   be paid for with a hub-only origin check.

### Rejected

- **Headline + `saved_at` only.** Preserves hard rule 5 and the history-less property; tells the
  second machine that a note exists and nothing of what it says. The gap would stay half-open under
  a row that says "closed".
- **Max-merging `last_read_ts`.** The number is a receipt clock and differs per machine. Silent
  loss of unread acts, in the exact shape lane `01M1FAYTHQ` already fixed once.
- **A separate replication channel for memory bodies, outside the audit log.** Keeps rule 5
  literally intact at the cost of a second log, a second allocator and a second fold — three things
  ADR 335 §8 exists to have exactly one of.
- **Agent seats excluded.** Tempting, since agents are one-node (ADR 042 kind scope, ADR 358), so
  their memory never needs to cross. But the writer does not know the seat's kind at the point it
  stamps, the row is small, and a rule with a kind-shaped hole is a second rule to keep in step.
  Every seat's continuity replicates; residence stops it going anywhere it should not.

## Consequences

- A human on two trusted machines (ADR 358) reads the same note and the same inbox position on both
  after one sync tick. That is the case this ADR is for, and it is the case `sync/continuity.test.ts`
  runs on two real daemons.
- **The audit log holds memory bodies.** Anything that reads or exports audit rows now sees notes
  — daemon-side only, but a seat writing a secret into its memory note has written it somewhere
  forever. ADR 093's no-secrets guidance for the note itself is now load-bearing rather than
  belt-and-braces. Never git: `.musterd/` is untouched.
- **Seat memory has a history.** Every save since this ADR is a row. The blob is still the only thing
  `GET /memory` returns; the history is a consequence, not a feature, and nothing reads it yet.
- The fold has a fifth kind and two new stop shapes (`unknown_continuity_event`, `cursor_unborn`).
- `memory.save` / `memory.clear` audit rows stop being written; `integration.test.ts` inverted
  from "sizes only" to "carries the note" on purpose, and says why in place.
- Census gap 2 closes; gap 3 (the insight substrate, lane `01M1JNY95C`) stays open.

## Observability & Evaluation

**Traces** — `continuity.*` rows carry an origin stamp, and every machine holds the same row with the
same stamp. Falsify on two live daemons: save a note on one, `GET /memory` on the other after a tick;
the body must match. Advance the cursor on one; on the other,
`SELECT last_read_message_id FROM inbox_cursors` must name the same message and `last_read_ts` must
equal *that daemon's* `messages.created_at` for it — not the origin's.

**Eval** — two halves, the second the one that matters.
1. *Continuity crosses.* A note saved on the joiner is readable on the hub with its body; a clear
   removes it and it stays removed; a newer save beats an older clear. Tested on two in-process
   daemons (`sync/continuity.test.ts`).
2. *The cursor never swallows.* On two daemons that folded the same messages at different instants,
   advancing the cursor on one leaves the other's `last_read_ts` equal to its **own** `created_at`
   for that message, and `unread` on the other daemon is exactly the messages after it — none
   skipped. The first assertion is tested; the second is the landed-outcome check and needs a
   second machine this team does not yet run. The first real measurement is the first day a second
   daemon runs a seat that reads.

**Experiment** — pre-registered, on the first two-machine week (ADR 358's human on two laptops).
*Hypothesis:* a seat that resumes on machine B after closing on machine A reads its own last note on
B with no manual step, and its first `unread` on B lists exactly the acts that arrived after A's
last read — zero re-read, zero skipped. *Measure:* count `continuity.memory_saved` rows folded on B
against notes saved on A (must be 1:1 within one tick), and diff B's first-orientation `unread`
against A's last-read cursor (must be the empty set on both sides). *Baseline:* the census's
measured state — 0 notes cross, every act re-read. *Falsifier for decision 5:* any act A had read
appearing unread on B, or any act B should see missing, is the ts-cursor defect surviving federation
and reopens the lane. *Watch:* `cursor_unborn` stops must be transient (one tick); one that persists
is a message-replication defect wearing a cursor's shape, and is decision 6's falsifier.
