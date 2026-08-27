# 331 — the ordering substrate: `(origin_node, origin_seq)` on every logged event, stamped from the first message

- Status: proposed — 2026-08-27. Authored by stanley on lane `01M10AJKMPAK54TM0CCG35VZD9`, as the
  second increment of the ADR 325 federation build. **Amends [ADR 328](328-machine-credential.md)
  decisions 1 and 7** — see §Decision 1 below; that ADR landed at `c6a0de99` two hours before this
  one was drafted, and the amendment is the reason this is an ADR rather than a build task.
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

**1. The `nodes` table exists from this increment, holding exactly one self-minted local row — and
this amends ADR 328 decisions 7 and 1.**

ADR 328 §7 says a single-machine team's `nodes` table "is empty"; §1 says `origin_node` **is** a
`nodes` row id. Held together literally, they mean today's daemon has no legal value to stamp, and
every message written before federation is permanently unstamped. That is not a small
inconvenience deferred to increment 3 — it forces increment 3 to choose between leaving a
permanent hole in the sequence and **restamping an append-only log**, which is the one operation
this system must never perform. The contradiction is resolved now, in the increment that would
otherwise inherit it.

So: migration v47 creates `nodes` in the full ADR 328 shape with `credential_hash` **nullable**,
and inserts one row for this daemon if none exists — ULID `id`, `label` from the hostname,
`enrolled_at` and `credential_hash` NULL. Enrollment in increment 3 **adopts** that row: it writes
the credential hash and `enrolled_at` onto it. It does not create a second one, and it does not
touch a single `origin_node` stamp.

This is the principle ADR 328 §5 already established, applied one step earlier. That decision made
the node id a ULID on the row and explicitly *not* derived from the credential, so that identity
survives rotation. A row whose credential has not been minted *yet* is the same idea: the identity
is the row, the credential is a property of it. §5's "the id is stable across credential changes"
extends without strain to "stable across acquiring a credential at all".

§1's authentication argument survives too, and by ADR 328's own words. §7 states that on a
single-machine team "its daemon is its own hub". Origin and authenticating hub are the same
process, so a locally minted id is a hub-minted id — the degenerate case ADR 325 defined, taken at
its word rather than treated as an exception to it.

**What genuinely changes, and is not buried:** at enrollment a joining daemon **presents** an
existing `origin_node` id rather than receiving a fresh one. The origin-id namespace stops being
hub-controlled. ADR 328 §1 rejected sender-chosen provenance, and this is a real, if narrow,
step toward it — narrow because the hub still authenticates the *credential* and still owns the
binding of credential to origin; what it no longer owns is the choice of identifier. A hostile
joiner presenting another node's id becomes a case that must be explicitly refused, where under
328 as written it could not arise. The refusal is the guarded CAS that ADR is already built on:
`INSERT … WHERE NOT EXISTS(id bound to a different credential)`, `changes === 0` is a refusal, and
it is the same helper §Consequences of 328 already asked the build to extract. ULID collision
between honest nodes is not a practical risk; deliberate collision is, and it is checked rather
than assumed.

**2. `origin_seq` is a counter on the node row, incremented inside the writing transaction.**
`nodes.next_seq INTEGER NOT NULL DEFAULT 0`. `insertMessage` increments it and reads the new value
in the same transaction as the row insert. SQLite's single-writer lock makes the result monotone
and gapless by construction — there is no window in which two writers can read the same value,
and no separate store that can drift from the log it numbers.

The two rejected homes are in §Alternatives. The property worth naming here is *gapless*, not
merely increasing: a puller detecting holes needs to know that the absence of seq 7 means seq 7 is
undelivered. A counter that can skip — because a transaction rolled back after incrementing, or
because the value is derived from a `MAX()` over a table rows can leave — turns every hole into an
ambiguity, and the protocol built on it into one that cannot distinguish loss from silence.

**3. Both columns are `NOT NULL`, and existing rows backfill to the local node.** Every message
already in the log *did* originate on this daemon; stamping it with this node's id records a true
fact rather than inventing one. The backfill assigns `origin_seq` in `(ts, id)` order, so the
historical prefix is itself gapless and monotone, and `next_seq` is set past it. `NOT NULL` is the
point of doing it this way: the invariant is enforced by the schema rather than by the convention
that every future writer remembers to stamp.

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

- **The origin-id namespace is no longer hub-controlled.** Stated in §Decision 1 rather than here
  because it is a modification to ADR 328 §1's argument, not a side effect of it. The mitigation
  is a guarded CAS at enrollment; the residual risk is that a hub's origin ids now come from its
  joiners, so a node id is unique-by-ULID rather than unique-by-construction.
- **ADR 328 §7's promise is narrowed but not broken.** The `nodes` table is no longer empty on a
  single-machine team. What §7 actually promised operationally — no enrollment ceremony, no
  `msnode_` minted, no route changes, nothing new to run — all still holds. A reader of 328 should
  read §7 as amended here; the sentence "the `nodes` table is empty" is the part that is wrong.
- **`nodes` arrives before the credential work that motivated it.** Increment 3 inherits a table
  that already exists and already has a row, which is a smaller and better-tested starting point
  than creating both at once under an enrollment flow. The cost is that `credential_hash` is
  nullable, so "enrolled" is a state to check (`credential_hash IS NOT NULL`) rather than a state
  guaranteed by the row's existence.
- **Every message write now touches two tables.** `insertMessage` updates `nodes` and inserts into
  `messages`. Both are already inside the caller's transaction and the update is a single-row
  primary-key write, so the cost is small — but the log's write path is no longer append-only in
  the literal sense, and a future writer that inserts a message outside a transaction would break
  gaplessness rather than merely being slow. The single-insert-path property is what keeps this
  safe, and it is now load-bearing rather than incidental.
- **The migration is a rewind-and-replay case.** Per the note migration v31 left, the migration
  tests rewind `schema_version` and replay the tail, so v47's backfill must be idempotent under
  replay — hence guarded `ALTER`s and an insert-if-absent for the local node row, not a bare
  `INSERT`.
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
- **Eval:** four pinned cases. **(i)** *Gaplessness under concurrency* — N concurrent
  `insertMessage` calls yield exactly the sequence 1..N for this node with no duplicates and no
  holes (baseline: a read-then-write counter outside the transaction, which duplicates under the
  same interleavings — the 2026-08-01 double-claim defect's shape, third instance). **(ii)**
  *Monotone across restart* — the counter resumes past its pre-restart maximum, since it is a
  column and not process state. **(iii)** *Backfill is a gapless prefix* — after v47 on a
  populated DB, `origin_seq` over existing rows is exactly 1..count in `(ts, id)` order and
  `next_seq` is count+1. **(iv)** *No caller-supplied origin* — an envelope carrying `origin_node`
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
