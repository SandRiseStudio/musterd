# 360 — Push-level residence: ingest checks the seat, not just the team, for every replicated kind

- Status: proposed — 2026-09-02. Authored by stanley on lane `01M1J6F9M2T2AE8WM6SR786GK7`, the
  increment ADR 355 §5 named as "the general form of this same rule and … the next increment, not a
  footnote here." (359 is reserved for ryder's codex-hooks ADR, which collided on 357.)
- Date: 2026-09-02
- Builds on: [ADR 328](328-machine-credential.md) (§4: an admitted node speaks for the seats
  resident on it, and only those), [ADR 355](355-hub-arbitrates-a-joiners-claim.md) (§5: the
  binding, enforced on the claim path), [ADR 356](356-presence-replication.md) (§2: enforced at
  ingest for the presence kind), [ADR 358](358-human-seat-trusts-a-set-of-machines.md) (the set a
  human seat may hold), [ADR 232](232-ledger-seats-every-actor-on-the-roster.md) (service seats — the one kind exempted here)
- Lane: `01M1J6F9M2T2AE8WM6SR786GK7`

## Context

ADR 328 §4 decided that an admitted machine may act as its residents and nobody else. ADR 355 §5
enforced that where a claim is decided; ADR 356 §2 enforced it where a presence event is ingested.
What neither did — and ADR 355 said so, in the paragraph that deferred it — is the push itself: at
`14003d89` the hub's `ingestBatch` (`sync/log.ts`) checked the *team* an event named against the
authenticated node's team, and checked the *seat* only when `event.kind === 'presence'`. A joiner
credential could push a `message` whose envelope says `from: nick`, or a `lane.opened` /
`lane.handoff` / `lane.released` row whose actor is any roster name, and the hub staged it, folded
it, and replicated it to every machine under that name.

That is the same hole gptbot found in #1190 (the claim route accepting any `seat` the body named),
one surface over. The claim was the sharpest edge because a claim takes a lane; a forged message
or handoff is the next-sharpest because it *speaks* — and ADR 101/158's whole point is that what
the log says a seat said was said by that seat.

## Problem

Apply ADR 328 §4 at ingest to every replicated kind without breaking the two legitimate cases where
the pushing node is not the seat's node: the hub staging its own history (which includes rows it
wrote *on a joiner's behalf* after arbitrating a claim), and ADR 232's service seats, which are one
roster name running as a LaunchAgent on every machine.

## Decision

### 1. Every event has an actor, and the actor is the residence subject

`syncEventActor` (protocol): the envelope's `from` for a message, the audit row's `actor` for a
lane or presence transition. `ingestBatch` resolves it to a member and runs the same
`bindSeatToNode` the presence kind already ran — first-writer-wins for an unbound seat, a
membership test against the seat's set (ADR 358) otherwise — before the replay check, on every
event, replay or not. A refusal is `SyncResidenceError`, now carrying the offending `kind`; the
batch rolls back whole and the pusher's cursor stays, exactly as for presence. An actor that is not
on the roster binds nothing and refuses nothing — resolving it is the fold's job
(`unresolved_seat`), and `SYSTEM_RELEASER` (`musterd`, the lane sweeper) is the one row shape that
has no seat behind it by design.

### 2. The hub never refuses itself; it does bind its residents

A loopback push (ADR 335 §Finding 1: the hub stages its own history through the same `ingestBatch`
the route calls) is detected by `local_node` naming the pushing node. On loopback the binding still
runs — a hub resident who has only ever *messaged* here is the hub's before any joiner can name
them, which closes a gap ADR 356 left (a seat that opens-with-claim on the hub stays local and was
never bound) — but a seat bound elsewhere is not a refusal. Two reasons, both structural. The rows
were written under a **seat** credential the hub authenticated, and a machine credential was never
their authority. And the hub writes rows *as* a joiner's seat on purpose: `arbitrateClaim` binds the
seat to the joiner (ADR 355 §5), then writes `lane.claimed` and the `[lane] claimed` team act under
that seat from its own allocator. Refusing those on loopback would make every hub-arbitrated claim
poison the hub's own staging.

### 3. Service seats are resident everywhere

A seat of `kind: 'service'` (ADR 232) is neither bound nor checked. `autorefresh` is one roster name
and one LaunchAgent *per machine*; binding it to the first daemon that bounced would refuse every
other daemon's bounce announcement. The exemption is bounded by what a service seat can do: it
cannot claim or hold a lane (`arbitrateClaim` refuses it, ADR 232), cannot raise an ask, and its
acts are the ledger's own voice. A joiner credential speaking as `guardian` can put a line in the
stream; it cannot take work.

## Alternatives considered

- **Skip the offending event and stage the rest.** Silent loss wearing an ack — the shape every
  sync decision since ADR 335 §7 refuses. The batch refuses whole and says which seat and kind.
- **Exempt loopback from binding as well as refusal.** Then a hub human who only messages is never
  bound, and a joiner can bind them first. Binding on loopback costs nothing and closes that.
- **Bind service seats as a set automatically.** Equivalent in effect to exemption, with a row per
  machine nobody reads. Add it when a reader wants it.
- **Check residence at fold time instead.** The fold runs on every machine, including the joiner
  folding the hub's log; residence is the hub's decision input and belongs where the hub decides.

## Consequences

- No migration, no protocol shape change: `syncEventActor` is a helper over existing schemas; the
  403 the push route already returns (`bound_elsewhere` with `seat`, `node_id`, `node_label`) is
  unchanged. The joiner's `sync_push_refused_residence` log line no longer says "presence".
- **The sharp edge, named.** A human who acts on a second laptop before trusting it (ADR 358) now
  wedges that laptop's outbound sync on their first *message*, not only on their first presence
  attach: the batch is refused every tick at ERROR until `musterd node trust`, an admin unbind, or
  acting from where the seat lives. This is ADR 356's existing behaviour with more triggers, and
  ADR 358 is the release valve built for it. The joiner-side UX that says *that* rather than a log
  line is the next thing to build, not this increment. **Built 2026-09-02 (lane `01M1JACVN0`):**
  the refusal persists on the push cursor (migration v64), rides the roster payload as
  `sync.wedged` so `team_status`, `team_inbox_check` and `musterd status` show it to the seat
  named, appears in `musterd node list`, and names the remedy — `musterd node trust <this node>`
  from where the seat lives, or the new `musterd node unbind <seat>`. Cleared by the next
  accepted push.
- Test fixtures that opened lanes on the hub *as nick* and then claimed as nick from the joiner now
  open them as a separate hub-resident human (`hana`) — the rule was refusing them correctly.
- ADR 355 §5's "Push-level residence … is the next increment" is closed; the topology table's 3c
  row says so.

## Observability & Evaluation

- **Traces.** `seat.bound` rows whose first-bind event was a message or lane row (the ledger does
  not distinguish; the `sync_log` row at the same `now` does). A hub-side `bound_elsewhere` refusal
  of a *loopback* batch is the defect this ADR makes impossible — it would show as the hub's own
  push loop logging `sync_push_refused_residence` against its own node.
- **Eval.** `sync/push.test.ts` (two real daemons): a message from a seat bound to the hub is
  refused `403 bound_elsewhere`, nothing staged, cursor unmoved, `sync_push_refused_residence`
  logged with the seat; a lane row naming a seat bound elsewhere is refused and the rollback leaves
  the *earlier* message's seat unbound; a first message binds an unbound seat to the pusher; a
  service seat's message is accepted from a node it is not bound to and adds no binding. Loopback
  never refusing is exercised by every `claim.test.ts` case that arbitrates for a joiner seat and
  then stages the hub's history. All 92 sync tests green at this build.
- **Experiment.** Pre-registered: on the dogfood team once a second machine enrolls, every
  `seat.bound_elsewhere` (deny) row at ingest names a node that is not in that seat's set, and no
  `sync_push_refused_residence` line ever appears in the hub's own log. Falsify: either appearing.
- **What would overturn this.** A legitimate multi-machine actor that is not a service seat — an
  agent seat that must speak from two nodes — which is ADR 042's kind scope reopened, not a
  widening here.
