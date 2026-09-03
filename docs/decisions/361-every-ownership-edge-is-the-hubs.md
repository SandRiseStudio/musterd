# 361 — Every ownership edge is the hub's: release, handoff and close follow the claim behind the CAS, and the origin speaks

- Status: proposed — 2026-09-02. Authored by stanley on lane `01M1J93RJKGWA34Y7YF66PKB34`, the
  increment ADR 355 §Alternatives promised: "One edge, done properly and falsified, is the
  increment; the others follow it."
- Date: 2026-09-02
- Builds on: [ADR 325](325-multi-machine-federation.md) (§Authority split residence 1: "lane
  ownership and state transitions (claim, release, handoff acceptance, terminal close)" are
  hub-authoritative under a linearizable CAS; §Offline semantics), [ADR 355](355-hub-arbitrates-a-joiners-claim.md)
  (the claim behind the hub; §5 residence on the acting seat), [ADR 356](356-presence-replication.md)
  (the presence the live-incumbent rule consults is now whole on every machine), [ADR 360](360-push-level-residence.md)
  (a joiner's rows are residence-checked at ingest; the hub never refuses its own loopback)
- Lane: `01M1J93RJKGWA34Y7YF66PKB34`

## Context

ADR 325 named four edges as residence 1 — the facts where two machines must never both be right.
ADR 355 moved one of them, the self-claim, behind the hub, and said of the rest: "Handoffs
(naming someone else), releases, state moves and closes stay local and replicate as before. They
are residence-1 facts too, and each will move behind the hub in its own increment."

Verified at `f05d2517` (2026-09-02): on an enrolled joiner, `PATCH /lanes/:id` with
`state: open` (a release), `owner_seat: <other>` (a handoff), or `state: done` (a close) ran
`updateLane` against the *joiner's* row under the joiner's own guard and replicated the
transition as an audit row. The guard is a CAS against a row that may be a minute stale. Two
machines can both release, both close, or one can hand off a lane the hub has already given to
someone else — and the fold then applies both, in hub order, with the second silently winning.
The single-daemon test for this file was written for exactly that shape (`a handoff to someone
else stays local — only a self-claim is arbitrated`); it was asserting the deferral, not a rule.

## Problem

Move the remaining ownership/state edges behind the hub without duplicating the claim's
machinery, without moving the post-effects (acts, wakes, acceptance routing) off the machine
whose seat is acting, and without taking residence-2 edits offline.

## Decision

### 1. One rule: a patch that moves `owner_seat` or `state` is decided by the hub

`isOwnershipOrStatePatch(body)` is the predicate — the same one the local handler already used to
decide whether a write carries a guard. On an enrolled joiner such a patch is forwarded whole
(`SyncLanePatchRequest`: lane, seat, the entire `UpdateLane` body, and the joiner's read as
`expect`) to `POST /teams/:slug/sync/lane`. The claim is the special case it always was:
`/sync/claim` still answers, implemented as a lane patch of `{ owner_seat: seat }`, and
`claimAtHub` forwards through `patchAtHub`.

The whole body travels so one write lands one row: a submit is `state` + `merged` + a branch,
and splitting it into a hub write and a local write would put two rows in the log for one act.
Handler-level fields (`acceptor`, `handoff_note`) ride along and the hub's store ignores them —
they are inputs to the post-effects, which stay on the origin (§2).

Edits that move neither field — title, detail, scope, branch, goal — stay local and replicate as
residence 2. ADR 325's offline promise holds where it was made: a partitioned machine keeps its
coordination layer; what it loses is the four edges whose semantics demand agreement.

### 2. The policy is one function, run against the row the decider can see; the origin speaks

`decideLanePatch` is the block the local PATCH handler ran before its write — the ADR 232
service-seat refusals, ADR 203's live-incumbent rule for a self-directed takeover, ADR 305's
merged-strip on a counterpart close, and the guard — extracted so the hub runs it too. On the
hub it runs against the hub's row and the hub's presence (whole since ADR 356); the CAS then
runs with the *joiner's* expectation, so a stale read is a refusal naming the holder, never an
overwrite. On the joiner an arbitrated patch does not re-run the policy against its own stale
row: the hub decided, and refusing here what the hub allowed would be the double-authority the
hub exists to remove.

The hub writes the transition row — as the seat, from its own allocator, with `node` naming the
joiner on **every** `lane.*` row the write produces, not only `lane.claimed` — and emits no act.
The joiner runs the post-effects against the hub's answer: the `[lane] released` / `[lane]
claimed` team acts, the recipient's `handoff` act with the note, the acceptance routing on a
submit, the close record. That is where they belong: the acting seat lives there, its acts are
residence 2 and replicate anyway, and the acceptance picker consults residency and wake policy
that are local to the machine the reviewer lives on. **This also closes a duplicate ADR 355
shipped:** the hub's `/sync/claim` delivered its own `[lane] claimed` act *and* the joiner's
handler delivered one, so every hub-arbitrated claim produced two team acts on every machine
(falsifier: `an arbitrated claim produces exactly one [lane] claimed act`, red at `f05d2517`).

### 3. Refusals are the claim's, unchanged

`409 conflict` with `holder`/`state` when the lane moved or the incumbent is live; `403
bound_elsewhere` when the acting seat is bound to another node; `503 hub_unreachable` when the hub
cannot be asked — for a release, a handoff or a close exactly as for a claim, and the row stays
exactly as it was. "Not yet replicated" applies to a lane born on the joiner and closed before
its birth folded on the hub; the joiner retries after sync.

## Alternatives considered

- **Run the whole PATCH handler on the hub as the seat.** The handler is ~600 lines of
  post-effects that consult local residency, local wake leases and the local review-loop breaker.
  Moving it would either replicate residence-3 state or make the hub route wakes it cannot see.
  The hub decides the row; the origin does everything the row causes.
- **Forward only `{ owner_seat, state, merged }` and apply the rest locally.** Two writes, two
  audit rows, and a submit's branch could land after its state on a slow fold. One write.
- **Keep releases local — "letting go is never contended."** A release and a competing claim on
  two machines is the ADR 203 double-claim shape with one extra step; and a release of a lane
  the hub already handed to someone else clears an owner the releaser never held.
- **Arbitrate `awaiting_acceptance` differently from `done`.** Both are `state` moves and both
  carry `merged`; one rule, no special case to drift.

## Consequences

- Protocol: `SyncLanePatchRequestSchema`; `/sync/lane` beside `/sync/claim`. No migration.
- `LaneAudit.node` now stamps every row a hub-arbitrated write produces (`lane.claimed`,
  `lane.updated`, `lane.released`, `lane.state_changed`) — the residence trace ADR 355 §2
  described, on the rows it had left out.
- A joiner cannot release, hand off, submit or close a lane while its hub is down — the ADR 325
  availability sacrifice, now on all four edges it named. Messages, opens and field edits still
  work offline.
- The `[lane] claimed` duplicate is gone: one act per claim, minted where the seat acted.
- Known and unchanged: a handoff from a joiner to a seat resident on another machine mints the
  `handoff` act on the joiner; it reaches the recipient's inbox through the fold, but no wake
  lease is spent anywhere, because the wake ledger is residence 3 and the fold does not consult
  it. That is the next residence gap, not this increment's.

## Observability & Evaluation

- **Traces.** `lane.released` / `lane.state_changed` / `lane.updated` rows on the hub whose
  `detail.node` names a joiner are arbitrated transitions; a joiner-origin row of those actions
  for a lane whose seat is joiner-resident is the defect this ADR makes impossible. Two
  `[lane] claimed` messages for one `lane.claimed` row is the duplicate §2 closed.
- **Eval.** `sync/claim.test.ts`, two real daemons: a release on the joiner is decided by the hub
  (hub row open, `lane.released` on the hub with `node`, none joiner-origin, one `[lane] released`
  act on the joiner); a handoff on a stale joiner row is `409` naming the real holder with the
  joiner row untouched and no handoff act; a handoff lands on the hub and the recipient's act is
  minted once, on the joiner, never on the hub; a close while the hub is unreachable is `503` and
  moves nothing; a handoff while unreachable is `503` while a title edit still lands; an
  arbitrated claim yields exactly one `[lane] claimed` act on both machines. The pre-existing
  claim, presence and lane-replication suites are unchanged except the one case that asserted the
  deferral.
- **Experiment.** Pre-registered: on the dogfood team once a second machine enrolls, every
  `lane.released` / `lane.state_changed` row whose actor is a joiner-resident seat carries
  `detail.node`, and no lane ever carries two terminal-close rows from different origins. Falsify:
  either row shape appearing.
- **What would overturn this.** A measured need to release or close while partitioned that
  outweighs the double-authority risk — a new ADR amending 325's offline rule, as 355 said.
