# 335 — the sync wire format: the replicated event is the `Envelope` plus its origin stamp

- Status: accepted — 2026-08-31 (merged `46707cb5` as #1102; dolly PASS at `f6bc359d` after two
  review rounds — REQUEST CHANGES at `57c27e1b`, non-blocking notes closed later at `789c7055` —
  then wanderer's cross-family acceptance of the lane at `46707cb5`, which read the falsifiers
  below against the landed code). Authored by stanley on lane `01M12FKECH1CA0DCY7X3H0KMBE`, as
  increment 3b-i of the ADR 325 federation build. Written because increment 3a's review asked for
  it: izzo, 2026-08-27, on #1100 — *"write the real ADR for the protocol addition rather than
  riding the 331 amendment; a second guard already lives outside both ADRs and this finding shows
  the guard set needs a home."* This is that home.
- Date: 2026-08-28
- Builds on: [ADR 325](325-multi-machine-federation.md) (the sync model, and the residence rules
  that decide what may cross a machine boundary), [ADR 328](328-machine-credential.md) (the
  credential that admits the surface, and §3's independence of admission from authorization),
  [ADR 331](331-ordering-substrate.md) (`(origin_node, origin_seq)`, the pair this ships),
  [ADR 131](131-harness-residency-wake-ledger-host.md) §4 (`from_provenance`, the one derived field that travels)
- Lane: `01M12FKECH1CA0DCY7X3H0KMBE`

## Context

ADR 331 gave every logged event a `(origin_node, origin_seq)` stamp and ADR 328 made `origin_node`
a principal the hub authenticates. Neither said what an event *looks like* on the wire, because
neither had to: nothing crossed a machine boundary yet.

Increment 3b-i is where something does. That forces three questions the earlier ADRs left open, and
all three are contract questions — they change `packages/protocol/src/`, which other
implementations depend on (AGENTS.md hard rule 1):

1. **What is the replicated event?** A message row, or the envelope, or a third shape?
2. **Which server-derived fields travel with it?** The log carries several fields no caller
   supplied. They are not uniformly safe to ship.
3. **What may a node say about origin?** ADR 328 authenticates the pusher. It does not say what the
   pusher is then entitled to claim.

## Problem

A wire format is the hardest thing in this build to change later, because it is the only part other
implementations compile against. Getting it wrong is not a refactor. And the tempting answers to all
three questions are wrong in the same direction: they ship *more* of the local row than is true off
this machine.

## Decision

### 1. The replicated event is `EnvelopeSchema` **composed**, plus the origin stamp

`SyncEvent` is `{ envelope, origin_node, origin_seq, from_provenance }`, where `envelope` is
`EnvelopeSchema` itself — not a restatement of its fields.

Composition rather than restatement keeps the act vocabulary, the `meta` rules and the slug regex in
ONE place. A restated shape drifts, and the drift has a specific and bad shape: it looks like *"this
act is replicable but unvalidated"*, which is a way to smuggle a payload past the rules the local
path enforces. The receiving hub therefore runs exactly the validation the sender's own daemon ran.

### 2. The wire names its sender by **seat name**, never by `from_member`

`messages.from_member` is a daemon-private anchor. ADR 325 keeps `id`/`token_hash` private and
replicates roster identity via git ([ADR 058](058-durable-on-git-live-on-daemon.md)), so a member id
means nothing on another machine — or, worse, means something *different*: it may resolve to another
seat that happens to hold that id there. `Envelope.from` already carries the seat name and
`Envelope.team` the slug, which is exactly what crossing a machine boundary requires.

This is not a serialization detail. It is the reason the envelope is the right unit at all: the
envelope was already designed to be meaningful to a party that does not share this daemon's tables.

### 3. `from_provenance` travels; `created_at` does not

`from_provenance` is an attested fact *about the event* — how the sending session was animated
(ADR 131 §4). Attestation is stamped per-event at insert precisely so it survives replication
(ADRs 101/158), so dropping it here would discard the thing that stamping was for.

`created_at` is local receipt time. Shipping the origin's would assert a falsehood about when *this*
machine learned of the event, and every consumer that later distinguishes "when it happened" from
"when we heard" would be reading a lie. `ts` (the sender's claimed time) already travels inside the
envelope, where its untrustworthiness is understood.

The general rule, for the fields 3b-ii and later will face: **a server-derived field travels iff it
is a claim about the event; it stays local iff it is a claim about this machine's relationship to
the event.**

### 4. A node may push only its own events, and only to a team it belongs to

Two refusals, and they are different refusals:

- **The batch's origin must be the authenticated node.** Without this, ADR 328 §1's "origin is a
  fact the hub authenticated" is aspiration: one compromised machine could mint events attributed to
  any other. The check is one comparison and it is the reason carrying the stamp is worth anything.
- **The authenticated node must belong to the team being written.** `nodes.id` is a GLOBAL primary
  key while a node belongs to exactly one team, so an authenticated node id proves *identity* and
  not *entitlement*. This is stated here because the distinction has already been got wrong once on
  this surface: increment 3a's one confirmed hole (izzo, 2026-08-27) was a guard that scoped to the
  requested team while the id it guarded was global.

A third, from the same principle: **the envelope may not name a team other than the one it is pushed
into.** The hub authenticated the team, so the payload does not get to contradict it. Nothing in
3b-i reads `envelope.team` — 3b-ii's fold is the reader, and a row whose `team_id` says one team
while its payload says another is a contradiction the staging layer already had the information to
refuse.

That check compares against `teams.slug`, which is safe **because slugs are immutable in practice**:
`store/teams.ts` updates `agent_key_hash`, `policy`, the display fields and `archived_at`, and never
`slug` (verified by dolly, 2026-08-28). If slugs ever become mutable, this check turns every
previously-minted envelope into a permanent 403, and it must move to comparing team ids.

Both refusals roll the whole batch back. A partially applied batch leaves a hole the pusher believes
it has closed — which is the loss-versus-silence ambiguity ADR 331 exists to prevent, reintroduced
at the transport layer.

### 5. Idempotence is keyed on `(origin_node, origin_seq)`, never on the envelope id

A replayed batch — the realistic case, since a lost ack means the pusher retries — must be a no-op.
The key is the pair, because that is what the protocol *orders* by: a duplicate under it is a
duplicate in the only sense the sequence cares about.

The envelope id is deliberately **not** the key. Two distinct events could carry one id — through a
bug, a restore, or malice — and treating that as a replay would drop the second while the origin's
sequence advanced past it, so the origin would believe the hub holds an event it never stored. That
is silent loss wearing an ack. Under this decision such a collision is loud instead.

A consequence worth naming, because it is what makes the canonical order *dense* rather than merely
unique: since nothing can silently decline to insert, every `hub_seq` allocated is a `hub_seq`
stored.

### 6. Envelope-id uniqueness is scoped to the **origin**, and never wider

`sync_log` holds `UNIQUE(origin_node, id)`. The envelope id is not a primary key and not unique per
team.

Envelope ids are minted by the origin daemon, so for any enrolled node they are attacker-chosen. A
uniqueness scope wider than the origin therefore hands every node a weapon against every other node
inside that scope: stage the id your target will use next, and its pushes fail on the constraint
forever. The refusal is correct in isolation and terminal in aggregate — the batch rolls back, the
cursor rightly does not move, and the next tick resends into the same constraint. Scoping to the
*team* would only narrow the blast radius to same-team nodes, which is the population federation
exists to serve. (dolly, 2026-08-28, review of #1102, reproduced against `57c27e1b`.)

Scoping to the origin is both safe and sufficient: an origin cannot honestly mint one id twice —
`messages.id` is its own local primary key — so a repeat is corruption at that source, and wedging
only itself is the correct blast radius.

**A consequence 3b-ii must not inherit unstated: origin-scoping did not remove the wedge, it moved
it.** Two rows in one team may now share an envelope id, and `messages.id` is a PRIMARY KEY — so the
fold cannot write both. What was one node's push loop failing is now the whole team's fold failing,
and 3b-ii inherits it. The trade is still the right one — refusing at the door hands one node a
lever on another node's liveness, which is worse — but the cost is a real one and belongs here in
plain words, not softened into "the fold cannot assume the id identifies a row". (dolly,
2026-08-31, re-review of #1102.) Test: `sync/containment.test.ts` stages two rows in one team that
the fold cannot both write.

**The guard this decision installs is asymmetric, and knowing which half is loud matters.** An id
reused under a NEW `origin_seq` is refused terminally and loudly (§Decision 5). The same `origin_seq`
restaged under a DIFFERENT id is swallowed by the replay branch — `origin_seq < expected` returns
before anything compares ids — so the hub keeps its version, acks, and the origin advances its
cursor believing its newer body landed. Same corruption at the same source, opposite treatment: one
screams, the other is silent loss wearing an ack.

It is left asymmetric deliberately. Comparing ids on the replay path turns every lost ack into a
potential refusal, which is the failure this protocol is built around; an origin cannot honestly
mint two bodies under one seq; and 3b-ii's fold is the first place a divergent replay is detectable
against a stored payload. Falsifier: `sync/log.test.ts`, "an origin that restages one seq under a
different id is silently acked, not refused".

### 7. Every refusal must be distinguishable from being offline

A pusher's default answer to failure is "retry next tick", which is right for an unreachable hub and
wrong for a refusal no retry can clear. Left undistinguished, a permanent rejection is reported
exactly as a laptop on a train: one warn line, forever.

So a terminal refusal is typed on the way out (`SyncDuplicateIdError`), carries `422` with the
offending `event_id`, and is logged by the daemon at **error**. The failure has to be legible from
the pushing machine's own log, without an operator reading the hub's database to find out why a
machine went quiet.

**"Terminal" describes the batch, not the loop.** The pass still retries every 60s, so the error
repeats until an operator acts; the loop is not given an exit. That is deliberate rather than
unfinished: skipping the offending event is silent loss, and choosing a drop policy belongs with the
fold in 3b-ii. The blast radius is self-only by §Decision 6, and reaching it at all requires an
origin to mint one id twice.

### 8. A hub's resume point is believed downward, bounded upward

The `409` gap refusal names where to resume, and §Decision 4 makes that binding — the hub is the
authority on what it holds. Upward it is not. A resume point ahead of anything this machine ever
minted cannot be a correction; it moves the cursor past real events that every later pass then
skips, which is the silent loss the cursor exists to prevent, reintroduced through the one number
the hub gets to dictate. `expected_seq` is refused above this node's own head + 1.

This needs no hostile hub to matter: any hub-side miscomputation of the resume point converts into
permanent data loss on the pusher, reported by nobody. (dolly, 2026-08-28, reproduced with a stubbed
hub answering `expected_seq: 1000000` against three unpushed messages.)

The ceiling is read from the node's **allocator** (`nodes.next_seq - 1`), not from
`MAX(origin_seq) FROM messages`. One allocator serves every replicated kind, so the moment a second
kind draws from it — 3c's lane claims — a messages-derived head under-reports and a *legitimate*
resume point trips this guard, wedging the loop it exists to protect.

Both refusals on this path are logged at **error** with the offending resume point *and* this node's
head, per §Decision 7: without that, they reach `startSyncPush`'s catch as `sync_push_failed` — the
same line a laptop on a train writes every 60s — on the one branch guarding against silent data
loss. Falsifiers: `sync/push.test.ts`, "distinguishes an impossible resume point from being offline"
and "distinguishes a 409 with no usable resume point at all from being offline". (dolly, 2026-08-31.)

## Alternatives considered

**A parallel `SyncMessage` shape mirroring the message row.** Rejected: it restates the envelope's
fields, so the two drift, and it invites shipping `from_member` because the row has one. The row is
the wrong unit — it is this machine's record *of* an event, not the event.

**Idempotence on the envelope id (a plain `ON CONFLICT DO NOTHING` on the primary key).** Simpler,
and it was what this increment's implementation plan sketched. Rejected on the reasoning in
§Decision 5: it converts a corruption case into a silent drop, and it leaves holes in `hub_seq`
where the drop occurred.

**Shipping `created_at` and letting the receiver ignore it.** Rejected: a field on the wire is a
field implementations will read. If it must not be trusted, it must not be sent.

**Riding ADR 331's amendment rather than writing this.** What 3a did for its second guard, and what
izzo's review said not to repeat. The guard set now has a home; §Decision 4 is where the next such
guard goes.

## Consequences

- **`packages/protocol/src/sync.ts` is a contract.** `SyncEventSchema`, `SyncPushRequestSchema`,
  `SyncPushResponseSchema` and `SYNC_PUSH_MAX_BATCH` (500 — an unbounded batch is an
  unauthenticated-adjacent memory primitive) are what another implementation compiles against.
  Changing them needs an ADR, which is the rule that produced this one.
- **The receiver validates as strictly as the sender.** Composing `EnvelopeSchema` means a hub
  rejects anything the origin's own daemon would have rejected. It also means a protocol version
  skew between machines surfaces as a validation refusal rather than as a half-understood event.
- **`origin_seq` is positive, not merely non-negative.** `next_seq` starts at 1 (ADR 331
  §Decision 2), so seq 0 never exists; admitting it would invite a reader to treat 0 as "unset" and
  a gap check to compare against a value no origin ever wrote.
- **Nothing here applies an event.** This ADR governs what crosses the wire and what the hub
  refuses. Where a staged event goes — the fold into `messages` — is 3b-ii, and it is deliberately a
  separate decision because it is the second insert path ADR 331 §Consequences warned about.
- **The seat-name rule constrains the roster.** Replication by name is only sound while names are
  stable and git-replicated. A team that renames seats freely, or that lets two machines disagree
  about the roster, degrades this to an ambiguous reference. That is a real cost of ADR 058's split,
  accepted here rather than discovered later.

## Observability & Evaluation

- **Traces:** `sync_pushed` (team, count) and `sync_push_failed` (team, error) from the daemon
  loop; `sync_push_gap` when the hub names a resume point. A team whose `sync_push_failed` rate is
  steady rather than bursty is a misconfiguration, not an offline laptop — the two are
  distinguishable only because the pass reports the failure rather than returning zero.
- **Eval — dataset, baseline, and the falsifiers that can fail:** the dataset is the two-daemon acceptance fixture (a hub and a joiner on scratch DBs, three events pushed by the real 60s loop); the baseline is increment 3a's behaviour, where the same fixture stages nothing because no push surface exists. **(i)** *The seat name travels and the member id does
  not* — push a message and grep the staged payload for `from_member`; a hit means a daemon-private
  anchor left the machine. **(ii)** *A foreign origin is refused* — push a batch stamped with another
  node's id under a valid credential and assert nothing is staged; if it lands, §Decision 4's first
  refusal is decorative. **(iii)** *A node cannot write another team's log* — authenticate as a node
  of team A and push to team B; this is the 3a hole's shape, and it must be refused at the store,
  not only at the route. **(iv)** *A replayed batch burns no `hub_seq`* — replay and compare
  `sync_meta.next_hub_seq` before and after. This is the falsifier that distinguishes §Decision 5's
  ordering from a superficially similar one: idempotence that dropped the replay *after* allocating
  would leave the row count right and the canonical order full of holes, so **the row count is not
  the check**. **(v)** *A distinct event reusing a staged envelope id is loud* — push seq N+1
  carrying seq N's envelope id and assert a refusal rather than a silent drop. **(vi)** *One node
  cannot wedge another* — stage id X from node A, then push id X from node B, and assert B's event
  lands; if it throws, the uniqueness scope is wider than the origin and B's sync is dead until
  someone operates on the hub's database. **(vii)** *A resume point ahead of this node's head is
  refused* — answer a push with `expected_seq` far beyond `MAX(origin_seq)` and assert the cursor
  does not move. Assert at `head + 1` for the accepting case, not at `head`: the looser assertion
  passes under an off-by-one clamp, which is how that mutation first survived.
- **Experiment:** §Decision 3's rule — travels iff it is a claim about the event — is the
  falsifiable generalization here, and it was derived from two fields. The evidence arrives at
  3b-ii, which must decide the same question for the fold's fields. If that increment finds a field
  the rule classifies wrongly, or finds itself adding exceptions rather than applying it, then this
  is a description of two cases dressed as a principle and should be demoted to exactly that.
