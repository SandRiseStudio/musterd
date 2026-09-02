# 355 — federation 3c: the hub arbitrates a joiner's claim, and an unreachable hub refuses it

- Status: proposed — 2026-09-02. Authored by stanley on lane `01M12FKHB01R0RJMDSS6SJRYC9`
  (Federation increment 3c), opened by wanderer 2026-08-27 with dependencies corrected 2026-09-01.
  Builds directly on #1185 / ADR 353, which gave the hub every joiner's lane transitions to
  arbitrate over.
- Date: 2026-09-02
- Builds on: [ADR 325](325-multi-machine-federation.md) (§Authority split residence 1: lane
  ownership is hub-authoritative under a linearizable CAS; §Offline semantics: hub-authoritative
  acts refuse while the hub is unreachable), [ADR 203](203-a-claim-refuses-a-lane-a-live-teammate-owns.md)
  (the live-incumbent rule this moves to the hub), [ADR 328](328-machine-credential.md) (the
  `msnode_` credential that admits the surface), [ADR 353](353-lane-transitions-replicate-as-audit-rows.md)
  (the replicated `lane.claimed` row that carries the decision back out)
- Lane: `01M12FKHB01R0RJMDSS6SJRYC9`

## Context

After ADR 353 a lane opened on any machine is visible on every machine, with its transitions, and the
hub holds every joiner's claims in its own `audit` and `lanes`. What nothing did was *refuse* the
second of two claims for one lane across machines. Each daemon ran ADR 203's rule against its own
row and its own presence, was sure of itself, and wrote a `lane.claimed` — two machines, each right,
which is the definition ADR 325 gave of the fact a hub exists to hold.

ADR 325 decided the shape a year ahead of the build: lane ownership is residence 1, hub-authoritative
under a linearizable CAS; a claim that cannot reach the hub **refuses**, because "a provisional claim
that might lose on reconnect invites building in a lane you do not own — the exact failure musterd
exists to prevent." It also decided the arbitration rule "changes hands, not meaning": the hub
evaluates ADR 203's live-incumbent rule, because presence is local-only and exists nowhere else in
whole.

The single-machine daemon already has the CAS: `updateLane` takes a `LaneExpectation` and refuses a
write when the lane moved since the caller's read (`LaneConflictError`), and the PATCH handler arms
it for ownership and state patches. ADR 331's guarded-CAS refusal path for the credential→origin
binding is `bindNode`'s `ON CONFLICT(id) DO NOTHING`. This increment does not add a guard to an
unguarded path; it makes the existing guard the hub's to run.

## Problem

Route a joiner's self-claim to the hub, run the CAS there, carry the decision back to every machine,
and make every "no" distinguishable — the lane moved, the seat or lane is not on the hub yet, the hub
could not be asked — without a provisional local write on any path.

## Decision

### 1. On an enrolled joiner, a self-claim is forwarded to the hub; the joiner writes nothing

The lane PATCH handler recognises a self-claim — `owner_seat` names the caller and the caller is not
already the owner — and, when this daemon is an enrolled joiner for the team, sends it to
`POST /teams/:slug/sync/claim` on the hub, authenticated by the machine credential, carrying
`{ lane, seat, expect: { owner_seat, state } }` where `expect` is the joiner's read at decision time:
the same `LaneExpectation` the local PATCH would have armed.

The joiner does **not** call `updateLane`. Its row converges from the hub's `lane.claimed` event
through the ordinary fold. After a success it runs one pull immediately, best effort, so the caller's
next read agrees with the answer they were just given; if that pull fails the claim already holds at
the hub and the timer converges it. This is what makes "exactly one holder" a fact rather than a
race: there is one row the decision is made against, and one event that says what was decided.

Handoffs (naming someone else), releases, state moves and closes stay local and replicate as before.
They are residence-1 facts too, and each will move behind the hub in its own increment; this one is
the claim, because the claim is the edge where two machines building the same lane is created.

### 2. On the hub, `arbitrateClaim` runs the existing guard and rule against the hub's row

In order: the seat must resolve on the hub's roster (git lag is a refusal, not a fault); the lane must
exist on the hub (its `lane.opened` must have folded — "not yet replicated, retry after sync"); ADR
203's rule runs against the hub's presence (a live incumbent refuses); then the guarded `updateLane`
with the joiner's `expect`. A `LaneConflictError` becomes a refusal naming the holder and state.

The hub writes the `lane.claimed` row as the seat, from the hub's allocator, with one field added:
`node`, the joiner's node id. That is the residence *trace* in the replicated log, on the row that
records the acquisition. ~~That is the seat→node residence binding … rather than in a table nothing
else reads.~~ **Corrected by §5 (2026-09-02):** a trace is not a binding. The binding ADR 328 §4
requires is a hub-minted table the claim consults *before* it decides, and this ADR as first landed
had none — see §5.

The hub stages its own history immediately after arbitrating (a loopback push) so the joiner's pull
finds the row it was just told about.

### 3. Every "no" is distinguishable, and the unreachable hub is its own code

A refusal is `409` with `error.code = 'conflict'` and two fields beside the envelope — `holder` and
`state` — the way a sync gap carries `expected_seq`: a caller can act on a name (ask for a handoff)
where it cannot act on a sentence. The joiner relays the hub's refusal verbatim.

A hub that cannot be asked — connection refused, timeout, DNS — is `503` with the new error code
`hub_unreachable` (CLI exit 12). It is never folded into `conflict`: "the hub said no" and "the hub
could not be asked" call for opposite next moves, retry-after-handoff versus retry-later, and a code
that merged them would send a script the wrong way. The lane stays exactly as it was.

### 4. The displacement rule's input is the hub's presence, and that is priced, not hidden

ADR 325 §Consequences: "the claim CAS is exact; its policy input is not." The hub knows its own
presence only, so a seat resident on a joiner has no presence at the hub and reads as **not live** —
its lane is displaceable by any seat, as an offline seat's is today. This is the staleness the ADR
named, taken at its word: the ownership decision is linearizable, the liveness it consults is not
yet whole. Presence summaries reported upward (residence 3) are the slice that closes it, and until
they land the topology doc says so in the increments table. **Closed by [ADR 356](356-presence-replication.md), 2026-09-02.**

### 5. Residence is enforced, not merely recorded (amendment, 2026-09-02)

gptbot's acceptance review of #1190 found the hole in §2 as first landed: `/sync/claim`
authenticated the *node* and then accepted any `seat` the body named, so an admitted joiner
credential could claim as any roster seat. ADR 328 §4 had already decided the rule — "an admitted
node speaks for the seats resident on it, and only those", with residence a **hub-minted binding**,
first-writer-wins under a guarded CAS, re-bound only by an explicit act — and §2 above recorded the
residence on the `lane.claimed` row without ever consulting it.

The binding is now a table, `seat_nodes` (migration v59, `member_id` primary key as the CAS, the
`bindNode` shape). `assertSeatResident` runs in `arbitrateClaim` before anything about the lane is
read, and on every daemon's *local* self-claim path with the local node as the speaker, so a hub's
own residents are bound to it before any joiner can name them. A claim for a seat bound to another
node is `403 bound_elsewhere` (CLI exit 13) carrying `node_id` and `node_label`, relayed verbatim
by a joiner. The ledger holds `seat.bound` on first bind, `seat.bound_elsewhere` (deny) on each
refusal, and `seat.unbound` for the explicit re-bind act, `DELETE /teams/:slug/nodes/bindings/:seat`
under admin authority — the pair ADR 328 §Experiment pre-registered as its signal.

Two things this deliberately does not do. **Push-level residence**: a node can still push messages,
lane transitions and (after the presence slice) presence events naming any seat; ingest checks the
team, not the seat. That is the general form of this same rule and it is the next increment, not a
footnote here. **Kind-scoping**: the binding applies to human seats too, as ADR 328 wrote it. A
human who works from two laptops will meet `bound_elsewhere` on the second, and the unbind is the
release valve; whether humans should fan out across nodes the way ADR 042 lets them fan out across
surfaces is the evidence question ADR 328 left open, and the refusals are how it gets answered.

Falsifiers, in `sync/claim.test.ts`: a seat that claimed on the hub is refused when the joiner
claims as it, with the hub's node named and the lane untouched; after an admin unbind the joiner's
claim binds the seat to the joiner and the hub's own local claim as that seat is the one refused.
The store-level race — two nodes binding one seat, exactly one wins — is `store/nodes.residence.test.ts`.

## Alternatives considered

- **Provisional local claim, reconciled on reconnect.** Refused by ADR 325 in advance, for the
  reason that a claim that might lose invites building in a lane you do not own. Also refused by the
  data: the 2026-08-01 double claim (two seats, one lane, six minutes apart) is what ADR 203 was
  written for, and a provisional claim reintroduces it across machines.
- **Fold `hub_unreachable` into `conflict`.** One code fewer, one wrong next move for every caller.
- **A residence table on the hub, written at claim.** ~~Refused as a second store of a fact the log
  already holds.~~ **Reversed by §5:** the log holds the trace, but a claim cannot consult a fold of
  its own future output, and the guard has to run before the row is written. The table is the
  binding; the row stays the trace. It needs no replication — it is the hub's own decision input.
- **Arbitrate every ownership edge in this increment.** Handoffs and releases are less racy (a
  handoff names a recipient; a release lets go) and each has a wake on the far end to think about.
  One edge, done properly and falsified, is the increment; the others follow it.

## Consequences

- An enrolled joiner cannot claim a lane while its hub is down. That is the availability sacrifice
  ADR 325 chose for the one act whose semantics demand it; opening, editing and messaging still
  work offline.
- The hub's `lane.claimed` row is the record of a joiner's claim; the joiner has no local row of its
  own for it. A reader counting claims per origin node will see joiner claims stamped by the hub,
  with `node` naming the joiner.
- A lane born on a joiner cannot be claimed by that joiner until the hub has folded its birth
  (the "not yet replicated" refusal). At the 60s push interval that is up to a minute after open.
  Opening with `claim: true` stays local and is not arbitrated — a birth has no incumbent — so the
  common "open and take it" case is unaffected.
- Protocol: `SyncClaimRequestSchema`, `SyncClaimRefusalSchema`, and the `hub_unreachable` error code
  (HTTP 503, CLI exit 12). The message and lane sync events are untouched. §5 adds
  `SeatBoundElsewhereRefusalSchema` and `bound_elsewhere` (HTTP 403, CLI exit 13).
- §5: on a single-machine install every seat that self-claims is bound to the local node from the
  first claim after v59. Nothing changes in effect until a second machine enrolls; then the seats
  that have been building here are the hub's, and a seat that wants to move is one admin unbind.

## Observability & Evaluation

- **Traces.** A hub-arbitrated claim is a `lane.claimed` row on the hub whose `detail.node` names a
  node other than the hub's own; a local claim has no `node`. The joiner logs
  `sync_claim_hub_unreachable` at warn when the hub cannot be asked. A `lane.claimed` row for one
  lane from two origins with no `lane.released` between them is the defect this ADR exists to make
  impossible.
- **Eval.** Dataset: the two-daemon falsifier `packages/server/src/sync/claim.test.ts`, red before
  this increment on four of five cases. Baseline: before, a joiner's claim succeeded locally with the
  hub's row unowned and a competing claim was silently accepted on both machines. After: the
  joiner's claim is decided on the hub and its row names the joiner's node; a competing claim is
  refused `409` naming the holder with the joiner's row untouched; an unreachable hub refuses `503
  hub_unreachable` with the row untouched; a handoff stays local; a claim on a lane the hub has not
  folded is refused with "not yet replicated". Existing single-daemon claim tests are unchanged.
- **Experiment.** Pre-registered prediction: once a second machine enrolls on the dogfood team, no
  lane ever carries two `lane.claimed` rows from different origins without a `lane.released`
  between them (the ADR 203 double-claim shape, across machines), and every joiner-side claim during
  a hub outage appears in the joiner's log as `sync_claim_hub_unreachable` rather than as a
  `lane.claimed` row. Falsify: either row shape appearing.
- **What would overturn this.** A measured need to claim while partitioned that outweighs the
  double-build risk — that would be a new ADR amending 325's offline rule, not an exception here.
