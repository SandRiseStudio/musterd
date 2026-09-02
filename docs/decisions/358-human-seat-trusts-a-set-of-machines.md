# 358 — A human seat trusts a set of machines; a second node joins by an explicit act from a bound session

- Status: proposed — 2026-09-02. Authored by stanley on lane `01M1J17QHK66WA79KZVKS8PGT2`, the
  follow-on ADR 355 §5 named when it applied residence to human seats "as ADR 328 wrote it" and
  left fan-out across machines as the open evidence question.
- Date: 2026-09-02
- Builds on: [ADR 042](042-humans-multi-presence.md) (single-active is kind-scoped: humans fan out,
  agents do not), [ADR 328](328-machine-credential.md) (§4: an admitted node speaks for the seats
  resident on it, and only those; residence is hub-minted, first-writer-wins, re-bound only by an
  explicit act), [ADR 355](355-hub-arbitrates-a-joiners-claim.md) (§5: `seat_nodes`,
  `assertSeatResident`, `bound_elsewhere`), [ADR 356](356-presence-replication.md) (residence at
  ingest binds a seat on its first `presence.*`)
- Lane: `01M1J17QHK66WA79KZVKS8PGT2`

## Context

After #1195 (ADR 355 §5) and #1200 (ADR 356) every seat is bound to exactly one node: the first
node to claim as it, or to push a presence event naming it, holds it, and every other node meets
`403 bound_elsewhere`. For agents that is right and free — single-active across machines falls out
of the same row that stops an admitted credential from claiming as any roster seat. For humans it
protects each person's seat from other machines, which is also right.

What it gets wrong is one human on two laptops. ADR 042 decided that a human may hold many
Presences on one seat because "watching on a phone while acting on a laptop" is an everyday
pattern, not an agent hazard; ADR 328 §4 wrote the binding for every kind and said the refusals
would show whether that was too tight. On 2026-09-02, one day after the binding landed, the
refusal arrived in the design conversation before it arrived in the ledger: nick's seat binds to
whichever machine he touched first, and the second is `bound_elsewhere` with an admin unbind as
the only way through — which moves the seat rather than widening it, so the first laptop is then
the one refused.

Decided with nick the same day (lane `01M1J17QHK`): keep the one-node binding as the default, and
let a **human** seat hold a **set** of bound nodes, where a second node is added only by an
explicit act from a session on a node already in the set.

## Problem

Let a human seat live on more than one machine without reopening the hole ADR 355 §5 closed: an
admitted node must still be unable to speak for a seat it does not hold, a fresh machine must
still be unable to make itself a holder, and agents must stay one-node with no change in effect.

## Decision

### 1. The binding is a set, keyed `(member_id, node_id)`; first-writer-wins holds for an empty set

Migration v63 rebuilds `seat_nodes` with the composite key. `bindSeatToNode` keeps the guarded
CAS, now as `INSERT … WHERE NOT EXISTS (any row for this seat)`: two nodes racing an unbound seat
still serialise on SQLite's single writer and exactly one inserts. A seat with rows accepts a node
in its set and refuses every other, naming the first-bound node. Nothing that reads the binding —
`assertSeatResident` on the claim paths, the presence-ingest check in `sync/log.ts` — changes; a
membership test was already the shape of the check, against a set of one.

### 2. A second node joins only by the trust act, and only a node already in the set can speak it

`trustNodeForSeat(seat, speaker, target)`: the speaker must be in the seat's set — that is the
entire rule. An empty set has no voucher (the seat binds to its first node the ordinary way, by
acting from it); a node outside the set is refused whatever seat token it presents, because the
refusal is about *which machine is asking*, not who. The target must be an enrolled, unrevoked
node of the team. A repeat is idempotent and writes nothing.

Two routes carry it. `POST /teams/:slug/nodes/trust` `{ node_id }` is the seat-facing act,
authenticated as the seat, for the caller's own seat only; the daemon it lands on is the vouching
node. On an enrolled joiner it is forwarded to the hub as `POST /teams/:slug/sync/trust`
`{ seat, node_id }` under the machine credential — the claim's shape exactly: the hub authenticates
the *node*, and residence decides whether that node may speak for that seat. The joiner writes
nothing; the hub's set is the fact. The CLI verb is `musterd node trust <node-id>`.

### 3. Agents stay one-node

`trustNodeForSeat` refuses a non-human seat with `forbidden`. ADR 042's kind scope carries to
machines for the same reason it existed for surfaces: two live sessions of one agent on two
machines is the parallel-minds hazard, and the admin unbind — which moves a seat, never widens it
— stays the only path for an agent that changed laptops.

### 4. The ledger

`seat.node_trusted` (allow) on each fresh row, with `node`, `by_node`, `by_label`. A refused act
from a node outside the set writes `seat.bound_elsewhere` (deny) with `act: 'trust'` beside the
usual `bound_to` — the same row ADR 328 §Experiment watches, so a machine probing for seats it
does not hold looks the same whether it probes by claim or by trust. `seat.unbound` is unchanged
and clears the whole set: the release valve stays one act.

## Alternatives considered

- **Kind-scope the binding: humans unbound, agents bound.** Refused in the lane's opening note and
  again here: an admitted machine could then speak as any human on the roster, which is the exact
  hole §5 closed, and humans are the seats whose authority a stolen credential most wants.
- **Let the second machine bind itself with a seat token.** The token proves the person; it does
  not prove the machine is one the person meant to trust — a credential on a laptop the person
  has never touched is the case this refuses. Vouching from a machine already in the set is what
  ties the act to a session the person is actually in.
- **A per-node unbind (`DELETE …/bindings/:seat/:node`).** Not needed to land the set; the whole-set
  unbind moves a seat in one act, and a human who wants to drop one laptop can unbind and re-trust.
  Add it when a real seat asks for it.
- **Replicate `seat_nodes`.** Still no: it is the hub's decision input (ADR 355 §5's reasoning),
  and a joiner never consults it — it asks.

## Consequences

- Migration v63. `seat_nodes` primary key becomes `(member_id, node_id)`; existing rows carry over
  one-for-one, so every seat's set starts as the one node it already had.
- Protocol: `SyncTrustRequestSchema`, `SeatNodeTrustedSchema`. Refusals reuse `bound_elsewhere`
  (403, CLI exit 13) for the wrong-speaker case, `forbidden` for an agent seat, `not_found` for an
  unknown target. `hub_unreachable` applies as it does to a claim: the act refuses, nothing is
  provisional.
- A human on two laptops: act as yourself once from laptop A (a claim binds it), then
  `musterd node trust <laptop-B's node id>` from A, then both claim as you. A third laptop is the
  same act from either.
- `seatBinding` (singular) still answers "the first-bound node" for every reader that names a
  holder; `seatBindings` is the set.

## Observability & Evaluation

- **Traces.** `seat.node_trusted` rows on the hub; `seat.bound_elsewhere` rows whose detail carries
  `act: 'trust'` are trust attempts from outside the set. A `seat.node_trusted` row whose `by_node`
  is not in the seat's set at that row's time is the defect this ADR exists to make impossible.
- **Eval.** `store/nodes.residence.test.ts`: an empty set has no voucher; a node outside the set
  cannot trust itself; from a bound node the act adds another and both then bind; agents are
  refused; unknown and revoked targets are refused; unbind clears the set. `sync/claim.test.ts`
  (two real daemons): a joiner asking for itself with a valid seat token is `403 bound_elsewhere`
  naming the hub's node with the set untouched and a deny row written; after the hub-side trust
  both machines claim as the seat and the forwarded repeat from the joiner is idempotent; an
  unknown node is `404`; the admin unbind empties the set.
- **Experiment.** Pre-registered: on the dogfood team, no `seat.node_trusted` row ever appears for
  an agent seat, and every `seat.bound_elsewhere` row with `act: 'trust'` names a `node` that is
  not in that seat's set. Falsify: either row shape appearing.
- **What would overturn this.** An agent workload that genuinely needs two machines under one
  seat — that is a new ADR revisiting ADR 042's kind scope, not a widening here.
