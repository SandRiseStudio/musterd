# 331 — the ordering substrate: `(origin_node, origin_seq)` on every logged event, stamped from the first message

- Status: accepted — 2026-08-27 (merged `e8683532`; ryder ACCEPT at `f3362b63` after a REJECT at
  `dcda5b57` whose two REQUIRED — the transaction premise below was false as first drafted, and the
  per-team/per-daemon question was undeclared — were both applied). Authored by stanley on lane `01M10AJKMPAK54TM0CCG35VZD9`, as the
  second increment of the ADR 325 federation build. **Amends [ADR 328](328-machine-credential.md)
  decision 7** — see §Decision 1 below; that ADR landed at `c6a0de99` two hours before this one was
  drafted, and the amendment is the reason this is an ADR rather than a build task.
- Date: 2026-08-27
- Builds on: [ADR 325](325-multi-machine-federation.md) (which named this pair as "the global
  ordering primitive the schema currently lacks"), [ADR 328](328-machine-credential.md) (which made
  `origin_node` a principal rather than a label — and which this amends),
  [ADR 003](003-ddl-as-ts-constant.md) (the frozen v1 DDL, why this is a migration and not a schema
  edit), [ADR 101](101-model-as-a-variable.md) /
  [ADR 158](158-model-attestation-truth.md) (per-event attestation stamped at insert, the pattern
  this follows), [ADR 259](259-memory-git-truth-derived-indexes.md) (declared caches — why the FTS
  index of ADR 327 is *not* a replicated table)
- Lane: `01M10AJKMPAK54TM0CCG35VZD9`

## Context

The message log orders by ULID `id` and by `ts`. Both are wall-clock derived, and on a
single-writer daemon that is sufficient: one process, one clock, one append point
(`store/messages.ts` `insertMessage`, the sole `INSERT INTO messages` in the codebase).

Federation removes the property that made it sufficient. ADR 325:

> Every replicated event carries `(origin_node, origin_seq)` stamped at its origin daemon, in
> addition to its ULID id and `ts`. `origin_seq` is a per-node monotone counter — the global
> ordering primitive the schema currently lacks.

Two distinct things break without it, and only the first is usually noticed. **Clock skew
reorders history**: two daemons appending concurrently produce ULIDs whose lexical order reflects
their machines' clocks, not causality, and a hub merging them has no ground truth to sort by.
**Absence is indistinguishable from a gap**: a puller holding events 1–4 and 10 from node B cannot
tell whether 5–9 are undelivered or were never written. The first corrupts order; the second
corrupts *completeness*, and a sync protocol that cannot detect its own holes will report success
while silently missing events. A per-origin gapless counter answers both, which is why ADR 325
made it the substrate rather than an optimization.

ADR 328 then gave `origin_node` its meaning — the `nodes` row id, a principal the hub
authenticates, deliberately not a self-asserted label like ADR 131's `host` string.

## Problem

Decide how `(origin_node, origin_seq)` is stored, minted, and backfilled in the local message log
— including what a daemon stamps *today*, when no second machine exists, no hub is remote, and no
`msnode_` has ever been minted. Without deciding the wire format, the sync routes, or the
enrollment CLI, all of which remain ADR 325 increment 3.

## Decision

**1. The `nodes` table exists from this increment, holding one self-minted local row per team —
and this amends ADR 328 decision 7.**

ADR 328 §7 says a single-machine team's `nodes` table "is empty"; §1 says `origin_node` **is** a
`nodes` row id. Held together literally, they mean today's daemon has no legal value to stamp, and
every message written before federation is permanently unstamped. That is not a small
inconvenience deferred to increment 3 — it forces increment 3 to choose between leaving a
permanent hole in the sequence and **restamping an append-only log**, which is the one operation
this system must never perform. The contradiction is resolved now, in the increment that would
otherwise inherit it.

So: migration v47 creates `nodes` in ADR 328's shape with three departures named in §Consequences,
of which the relevant one here is that `credential_hash` is **nullable**. It inserts one row per
team this daemon hosts, if absent — ULID `id`, the team's `team_id`, `label` from the hostname,
`enrolled_at` and `credential_hash` NULL. Enrollment in increment 3 **adopts** the row for the
team being enrolled: it writes the credential hash and `enrolled_at` onto it. It does not create a
second one, and it does not touch a single `origin_node` stamp.

**The row is per (daemon, team), not per daemon** — ADR 328 §1 put `team_id` on the node row and
that is correct as written, needing no further amendment. Federation is per-team by ADR 325's
topology: *one team, one authority*. A daemon hosting two teams syncs to two hubs, is admitted
separately at each, and must be separately revocable at each — so it holds two node identities and
two independent `origin_seq` streams. `origin_node` therefore names a machine-*team*, and
`next_seq` is per node row, which is per (machine, team). Naming a bare machine would mean one
identity spanning two hubs that cannot see each other, which is not an identity any authority
could authenticate. This is the same shape ADR 328 §Consequences already accepted when it noted a
re-enrolled machine becomes two origins: node identity is per-enrollment, and enrollment is
per-team.

This is the principle ADR 328 §5 already established, applied one step earlier. That decision made
the node id a ULID on the row and explicitly *not* derived from the credential, so that identity
survives rotation. A row whose credential has not been minted *yet* is the same idea: the identity
is the row, the credential is a property of it. §5's "the id is stable across credential changes"
extends without strain to "stable across acquiring a credential at all".

§1's authentication argument survives too, and by ADR 328's own words. §7 states that on a
single-machine team "its daemon is its own hub". Origin and authenticating hub are the same
process, so a locally minted id is a hub-minted id — the degenerate case ADR 325 defined, taken at
its word rather than treated as an exception to it.

**What changes at enrollment, and why it does not soften §1:** a joining daemon **presents** an
existing `origin_node` id rather than receiving a fresh one. This is a change of *who allocates the
identifier*, not of who vouches for it, and §1's actual content is the latter. Its words are
"an event's origin is a fact the hub authenticated at ingest, not a string the sender chose" — and
under this decision the hub still authenticates: it verifies the `msnode_` credential and it writes
the credential→origin binding itself, under the guarded CAS, refusing an id already bound to a
different credential. What a sender proposes at first sight is not what a sender chose, because
the proposal only becomes an origin once the hub has bound it and can refuse to. §1 stands; a
later reader should not cite this ADR as the precedent that softened it.

The residual, priced honestly: after the CAS eliminates every dishonest joiner, what remains is
ULID collision between honest nodes — 80 bits of entropy per row, which is nothing. The real cost
is one refusal path that must exist where under 328 as written it could not arise, and it is the
same guarded-write helper 328's §Consequences already asked the build to extract. That is a
checklist item, not a weakening.

**2. `origin_seq` is a counter on the node row, and `insertMessage` opens the transaction that
increments it.** `nodes.next_seq INTEGER NOT NULL DEFAULT 1`, holding the **next value to assign**
— the meaning the name says, and the one §Decision 3's backfill (`next_seq = count_team + 1`) and
eval (iv) already assumed. (As merged this sentence said `DEFAULT 0` with the stamp read *after*
the increment; under that reading the backfill's `count_team + 1` burns a number, so the first
draft contradicted itself off-by-one. Amended at the build increment, 2026-08-27.) The read of the
current value, the increment, and the message insert are one atomic unit.

**`insertMessage` must open that transaction itself** — it cannot inherit one, because today there
is none to inherit. Its sole production caller is `protocol/route.ts:330` and there is no
`db.transaction` anywhere on that path; `packages/server/src/protocol/` contains none at all.
Absent this, the increment and the insert autocommit separately, and any throw between them — a
`UNIQUE` violation on a replayed envelope id is the realistic one — burns a sequence number and
leaves precisely the hole this decision exists to prevent. So `insertMessage` wraps both in
`db.transaction`, which better-sqlite3 nests as a `SAVEPOINT` when a caller already has one open,
making it a no-op for future callers that do their own transaction management.

With that, SQLite's single-writer lock makes the result monotone and gapless by construction:
there is no window in which two writers read the same value, no separate store that can drift from
the log it numbers, and no failure that advances the counter without producing the row it numbers.

The two rejected homes are in §Alternatives. The property worth naming here is *gapless*, not
merely increasing: a puller detecting holes needs to know that the absence of seq 7 means seq 7 is
undelivered. A counter that can skip — because a transaction rolled back after incrementing, or
because the value is derived from a `MAX()` over a table rows can leave — turns every hole into an
ambiguity, and the protocol built on it into one that cannot distinguish loss from silence.

**3. Both columns are `NOT NULL`, and existing rows backfill to this daemon's node row *for their
own team*.** Every message already in the log *did* originate on this daemon; stamping it with the
matching node's id records a true fact rather than inventing one. **The backfill partitions by
`team_id`**: within each partition it assigns `origin_seq` in `(ts, id)` order as `1..count_team`,
against that team's node row, and sets that row's `next_seq` to `count_team + 1`. There is no
single "the local node" to backfill to — §Decision 1 mints one row per (daemon, team), so a daemon
hosting N teams has N sequences, each of which must be a gapless prefix on its own.

A global numbering would not merely be untidy, it would be wrong on the first migration on the
machine we develop on. Measured on `~/.musterd/musterd.db`: 8034 messages across four teams with
traffic — 7774, 176, 83, and 1 — out of six teams hosted. Numbering that log 1..8034 in `(ts, id)`
order scatters the 176-message team's numbers through the whole range, so *no* node's sequence is a
gapless prefix and `next_seq` is wrong for every row however it is set. A puller for that team sees
holes everywhere, which by §Decision 2's own words means "seq 7 is lost, not merely unsent" — the
exact ambiguity this ADR exists to prevent, manufactured by its own migration.

`NOT NULL` is the point of doing it this way: the invariant is enforced by the schema rather than
by the convention that every future writer remembers to stamp.

**4. Stamped by the server at insert; there is no wire field.** The columns are set inside
`insertMessage`, alongside `from_provenance` — which is already exactly this pattern, and whose
comment already states the reason: "SERVER-derived by construction (there is no wire field), so a
wake-born session cannot masquerade". A caller cannot supply an origin any more than it can supply
a provenance. This is the same insistence ADRs 101/158 make about attestation, for the same
reason: a stamp the sender controls attests nothing.

**5. `messages` only, this increment.** ADR 325's replicated set is larger — lanes, goals, audit.
`messages` is the append-only log the others fold into, it has a single insert path, and it is the
one ADR 325 named first. The remaining tables follow in their own slices, against a substrate
already proven by this one. Derived caches are explicitly **not** replicated and get no columns:
ADR 327's `insights_fts` is a declared cache under ADR 259, rebuilt from the log, and stamping a
derivation with an origin would assert that the derivation is itself an event.

## Alternatives considered

- **Hold ADR 328 §7 as written; `origin_node` nullable until enrollment.** The smallest diff, and
  it leaves the freshly-accepted ADR untouched. Rejected because the cost is permanent and lands
  on someone else: pre-federation history is never attributable, `origin_seq` is verifiable only
  over the post-enrollment suffix, and increment 3 must still choose between a permanent hole and
  restamping the log. It also makes both columns nullable, which pushes a branch into every
  consumer and moves the invariant from the schema into everyone's memory. Deferring a decision is
  worth doing when new information is coming; here nothing arrives between now and increment 3
  except the cost of having waited.
- **A sentinel `'local'` string until enrollment, rewritten at enroll time.** Cheapest to write.
  Rejected twice over: it makes `origin_node` a value the writer picked, which is precisely what
  ADR 328 §1 forbids, and its enrollment step is a bulk `UPDATE` over history — restamping the
  append-only log, the operation §Decision 1 exists to avoid.
- **Derive `origin_seq` as `MAX(origin_seq)+1` for this node at insert.** No counter state to keep
  consistent, which is genuinely attractive. Rejected on the gapless property: it is an index scan
  on every send, and it *reuses* a sequence number if the tail row is ever removed — after which
  two distinct events share one `(origin_node, origin_seq)`, and the pair stops being an
  identifier at all. Deriving a counter from the rows it numbers makes the counter only as durable
  as the rows.
- **Keep the counter in `schema_meta`.** It exists, it is trivially durable. Rejected on
  residence: ADR 325 §3 classes `schema_meta` as local-only, never-replicated state, and a
  per-node counter keyed by node does not fit a flat key/value table once a second node exists.
  The counter belongs to the principal that owns the sequence, which is the node row.
- **A hybrid logical clock / vector clock instead of a per-origin counter.** Strictly more
  ordering information, and it would let a merged log express causality rather than just
  per-origin position. Rejected for scope, not merit: ADR 325 specified this pair and built its
  push/pull cursor model on it, the hub assigns the canonical total order on ingest, and a vector
  clock's cost — a per-node map on every event — buys concurrency detection nothing in this design
  yet consumes. Nothing here forecloses it; a causality upgrade would add a column beside these,
  not replace them.

## Consequences

- **Origin ids are allocated by joiners, bound by the hub.** Argued in §Decision 1 rather than
  here, because it is a claim about what ADR 328 §1 means and not a side effect of this one. The
  operational residue: a node id is unique-by-ULID rather than unique-by-construction, and
  increment 3 owes one refusal path for an id already bound to a different credential.
- **`nodes` departs from ADR 328 §1's stated shape in three ways**, all of them here rather than
  discovered in the diff: `next_seq` is added (§Decision 2), `credential_hash` is nullable
  (§Decision 1), and `enrolled_at` is nullable for the same reason. `enrolled_by`, `revoked_at`,
  and `last_seen_at` are created as 328 specified and stay unused until increment 3.
- **A future `messages` rebuild must carry the new columns.** Migrations v9 and v31
  (`migrations.ts:79`, `:300`) rebuild the table with `INSERT INTO messages_new SELECT * FROM
  messages` — positional, and correct only while the column lists match. SQLite cannot `ALTER` a
  `CHECK` in place, so the next act-vocabulary change will rebuild again, and that rebuild must
  include `origin_node` and `origin_seq` in `messages_new` or silently drop every stamp. This is
  the standing hazard of the `SELECT *` rebuild pattern; naming it here is cheaper than
  rediscovering it.
- **ADR 328 §7's promise is narrowed but not broken.** The `nodes` table is no longer empty on a
  single-machine team. What §7 actually promised operationally — no enrollment ceremony, no
  `msnode_` minted, no route changes, nothing new to run — all still holds. A reader of 328 should
  read §7 as amended here; the sentence "the `nodes` table is empty" is the part that is wrong.
- **`nodes` arrives before the credential work that motivated it.** Increment 3 inherits a table
  that already exists and already has a row, which is a smaller and better-tested starting point
  than creating both at once under an enrollment flow. The cost is that `credential_hash` is
  nullable, so "enrolled" is a state to check (`credential_hash IS NOT NULL`) rather than a state
  guaranteed by the row's existence.
- **Every message write now touches two tables, inside a transaction it opens itself.**
  `insertMessage` updates `nodes` and inserts into `messages`; the update is a single-row
  primary-key write, so the cost is a savepoint on a path that previously had none. Two things
  follow. The log's write path is no longer append-only in the literal sense. And the
  single-insert-path property — one production caller, one function — stops being incidental and
  becomes load-bearing: a second insert path that skipped `insertMessage` would break gaplessness
  rather than merely duplicating logic.
- **The migration is a rewind-and-replay case.** Per the note migration v31 left, the migration
  tests rewind `schema_version` and replay the tail, so v47's backfill must be idempotent under
  replay — hence guarded `ALTER`s and an insert-if-absent for **each team's** node row, not a bare
  `INSERT`, and a delete-first on the backfill so a replayed partition renumbers rather than
  doubling.
- **Not in scope:** the sync wire format and routes, the enrollment/rotation/revocation CLI, the
  hub storage engine (all increment 3), and origin stamps on lanes, goals, and the audit log
  (their own slices, per §Decision 5).

## Observability & Evaluation

- **Traces:** the pair is itself the trace ADR 325 promised — "lag is `hub_head − daemon_cursor`
  per node, a number the status surface can print". This increment makes that number *computable*
  locally: `MAX(origin_seq)` per `origin_node` is the head, and once increment 3 lands cursors,
  the difference is lag with no inference. Before then the stamps are inert but observable, which
  is the point of landing them a slice early — a substrate that has been writing correct values
  for a while is a better foundation than one whose first real use is also its first test.
- **Eval:** five pinned cases. **(i)** *Gaplessness under concurrency* — N concurrent
  `insertMessage` calls yield exactly the sequence 1..N for this node with no duplicates and no
  holes (baseline: a read-then-write counter outside the transaction, which duplicates under the
  same interleavings — the 2026-08-01 double-claim defect's shape, third instance). **(ii)** *A
  failed insert burns no number* — force the `messages` insert to throw after the increment (a
  duplicate envelope id does it), then assert `next_seq` is unchanged and the sequence has no
  hole. This is the falsifier for §Decision 2's transaction, and it is deliberately *not* case
  (i): (i) tests concurrency, this tests failure, and the premise that made the transaction
  necessary — that no caller supplies one — was false in this ADR's first draft and caught in
  review. **(iii)** *Monotone across restart* — the counter resumes past its pre-restart maximum,
  since it is a column and not process state. **(iv)** *Backfill is a gapless prefix per node* — after v47
  on a populated DB, `origin_seq` over each node's rows is exactly `1..count_team` in `(ts, id)`
  order and that node's `next_seq` is `count_team + 1`. **The fixture seeds at least two teams with
  interleaved timestamps**, because a single-team fixture passes identically under the global and
  the partitioned readings — it cannot fail, which is how the singular wording survived this ADR's
  first draft and its first review. **(v)** *No caller-supplied origin* — an envelope carrying `origin_node`
  or `origin_seq` fields has them ignored, the same falsifier `from_provenance` warrants.
  Migration rewind-and-replay is covered by the existing migration test harness rather than a new
  case.
- **Experiment:** the amendment in §Decision 1 is the falsifiable choice. It predicts that
  presented origin ids never collide in practice and that adoption-at-enrollment is a smaller
  change than mint-at-enrollment would have been. The evidence arrives at increment 3: if the
  adoption path needs special-casing beyond writing two fields onto an existing row — in
  particular if the hub finds it must re-mint after all, for a reason this ADR did not foresee —
  then holding ADR 328 §7 was the better call and the unstamped-history cost should have been
  paid. That is a concrete, near-term falsifier on a decision made a slice ahead of its consumer,
  which is exactly the kind of decision that most needs one.
