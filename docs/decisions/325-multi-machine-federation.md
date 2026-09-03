# 325 — multi-machine teams: one team, one authority; daemons federate as replicas

- Status: accepted — 2026-08-25 (ryder PASS on lane 01M0XDVE7S, all four census falsifiers
  independently re-run; landed #1069, 0110e65f)
- Date: 2026-08-25
- Supersedes (in part): [ADR 039](039-cross-network-topology.md) — its "federation explicitly out
  of scope" line and the identification of the invariant with a single *daemon*. Its invariant
  itself is kept and relocated (see Decision); its topologies A/B remain the correct answers for
  teams that fit on one daemon.
- Builds on: [ADR 058](058-durable-on-git-live-on-daemon.md) (roster identity replicates via git,
  unchanged here), [ADR 040](040-secured-off-loopback-bind.md) (the secured transport hub links
  ride), [ADR 048](048-plan-goal-work-item-model.md) ("minimal declared noun, derive everything else" —
  the maxim the sync model leans on) / [ADR 090](090-per-recipient-delivery-status.md) (delivery
  as a derived ledger, an instance of it),
  [ADR 131](131-harness-residency-wake-ledger-host.md) / [ADR 236](236-sleeping-host-defers.md)
  (host identity, lease exclusion, cross-machine liveness discrimination),
  [ADR 248](248-a-seed-is-captured-in-the-open-and-lands-as-a-lane.md) /
  [ADR 311](311-shared-seeds-are-slack-only.md) (the cursor-pull sync pattern this generalizes),
  [ADR 101](101-model-as-a-variable.md) / [ADR 158](158-model-attestation-truth.md) (attestation
  is stamped per-event at insert, so it replicates as part of the envelope),
  [ADR 134](134-provisioning-is-localhost-trust-enforced.md) /
  [ADR 170](170-signin-handoff.md) (the localhost-trust predicates a second machine breaks —
  named here, redesigned in a follow-on credential ADR)
- Lane: `01M0XDVE7SJ7PA7KS18QYQ1G3P`

## Context

ADR 039 decided "one team, one daemon, one authority": a team spanning networks reaches its single
daemon as clients over an overlay or a secured bind, and *many cooperating daemons* — federation —
was explicitly out of scope. That was the right cut for v0.3. It is now outgrown by intent: teams
are wanted with an unbounded member set — humans on different machines and networks, agents local
to each of those machines, and cloud agents with no machine of their own. A single daemon serves
that team only if every member tolerates a WAN round-trip on every seat action and total loss of
the coordination layer whenever their link to the daemon's host drops. musterd's value is being
present at every task boundary; it cannot be absent whenever the coffee-shop wifi is.

Three exploration censuses (2026-08-25; recorded in
[the federation data census](../wiki/federation-data-census.md)) established what the codebase
already gives us and where it resists:

**In our favor.** `messages` is a clean append-only funnel with a single writer and no
UPDATE/DELETE; Goals have no table at all — they fold from the message log at read time
(`packages/server/src/store/goals.ts`), and 18 store modules are pure read-time derivation
(ADR 048's maxim working as designed). Roster identity is *already* multi-machine replicated — via git,
projected idempotently into each daemon's SQLite (ADR 058, `packages/server/src/projection/`).
The seeds relay is a working cross-boundary sync: cursor-based at-least-once pull, idempotence on
a foreign immutable id, cursor advanced in the same transaction as the insert, fail-closed on
unrecognized shapes (`packages/server/src/seeds/ingest.ts`). Machine identity exists in the wake
path (`residency.host`, `~/.musterd/host-registry.json`, host-scoped `wake_leases`).

**Where it resists.** (1) There is no global ordering primitive — ordering is wall-clock
`(ts, ULID)`, two queries tie-break on local `rowid`, one table uses `AUTOINCREMENT`. (2) A lane
claim is a read-then-write across two statements with no transaction and no `WHERE` guard, and its
arbitration predicate — `hasLivePresence` — reads the one table that is meaningless off its host.
(3) `updateLane` overwrites the full row, so concurrent patches to unrelated fields clobber.
(4) `audit` is best-effort by contract (`appendAudit` swallows its own errors; ADR 131 already
ruled it "cannot bear correctness"), so it cannot be the replication log.

A landscape survey (2026-08-25, sources in the census page) confirmed the architecture rather than
offering a substitute: musterd's data splits into commutative append-only events, which many
things can sync, and exclusive claims, which need a linearizable compare-and-swap at a single
authority — the one thing CRDTs cannot express and last-write-wins sync engines silently corrupt.
Every surveyed product optimizes exactly one half. The design below encodes the split directly.

## Problem

Decide the topology and sync model for teams whose members span machines — preserving offline
usefulness on every machine, the exclusivity of lane ownership, per-event attestation and
provenance (ADRs 101/109/158), and the existing single-machine deployment as a degenerate case —
without committing now to a hub storage engine or to the cross-machine credential design.

## Decision

**The invariant relocates, it does not break: one team, one *authority*.** ADR 039 said "we move
only *where the daemon listens*, never *what the daemon is*." This ADR moves one more thing — who
holds authority — and still not what the daemon is. A team is served by one **hub** (the
authority) and any number of **machine daemons** (replicas). A machine daemon is today's daemon
unchanged in kind: same store, same clients, same synchronous SQLite. The hub is the same daemon
*promoted*: it additionally speaks the sync surface and is the sole arbiter of the facts that need
global agreement. A single-machine team is the degenerate case — its one daemon is its own hub,
and nothing about today's deployment changes.

**Authority split — three residences for state, decided by its consistency need:**

1. **Hub-authoritative (linearizable CAS):** lane ownership and state transitions (claim, release,
   handoff acceptance, terminal close), canonical total order of the team event log, and admission
   of remote daemons. These are the facts where two machines must never both be right.
2. **Locally-authoritative, replicated (append-only events):** messages (all acts), seed thread
   entries, wake turns, lane-transition events, and the audited verbs. Each machine appends
   locally and syncs; nothing here requires agreement, only eventual delivery and stable order.
3. **Local-only, never replicated:** presence, wake leases, footprint, schema meta. Presence is
   meaningful only on its host (ADR 058's live tier); each daemon reports a *summary* of its local
   presence upward as ordinary events, which is how the roster view of a remote machine is built.
   *Amended by [ADR 356](356-presence-replication.md), 2026-09-02:* presence **transitions**
   (`presence.attached|detached|reattested`) replicate as residence 2 — they are the summary;
   heartbeats, grace, `conn_id` and wake leases stay here.

Roster identity stays on git (ADR 058, unchanged): the hub does not sync `members` — the repo
does, and each daemon's reconciler converges on it. `id`/`token_hash` remain daemon-private
anchors.

**Sync model — the seeds-relay pattern, generalized and made bidirectional:**

- Every replicated event carries `(origin_node, origin_seq)` stamped at its origin daemon, in
  addition to its ULID id and `ts`. `origin_seq` is a per-node monotone counter — the global
  ordering primitive the schema currently lacks.
- Daemons **push** their origin-stamped events to the hub and **pull** the merged log with a
  cursor, both at-least-once, idempotent on origin ids, cursor advanced in the same transaction as
  the applied batch — exactly the properties `seeds/ingest.ts` already demonstrates. The hub
  assigns the canonical total order on ingest; daemons fold pulled events into their local store
  the way `goals.ts` folds today.
- Mutable current-state replicates as events folded locally, not as row sync — with two named
  exceptions that merge directly because their merge is trivial and order-free: `inbox_cursors`
  (monotone max) and `tool_call_stats` (additive counters).
- The relay's one-way constraint ("the buffer is never written back to", ADR 248) is not violated
  — it is *decomposed*. Each direction of the daemon↔hub link is separately one-way, cursor-based,
  and idempotent; there is no in-place mutation crossing the boundary in either direction.

**Offline semantics follow the authority split.** Local acts — messages, status updates, inbox
reads, opening lanes — append locally and sync when the hub is reachable; a partitioned machine
keeps its coordination layer. Hub-authoritative acts **refuse while the hub is unreachable**, with
a distinct error naming the reason. A lane claim is a CAS; a "provisional" claim that might lose
on reconnect invites building in a lane you do not own — the exact failure musterd exists to
prevent. This is a deliberate availability sacrifice on the one act whose semantics demand it.

**The lane-claim arbitration rule changes hands, not meaning.** Today's rule consults live
presence (`hasLivePresence`) to decide whether an incumbent may be displaced (ADR 203). Presence
is local-only, so under federation no peer can evaluate that rule — the hub arbitrates claims
using the presence summaries daemons report (residence 3 above). This is not merely acceptable
centralization; it is forced: the deciding input exists nowhere else in whole.

**The hub is engine-agnostic in this decision.** The hub is defined by the surface it speaks
(sync push/pull + claim CAS) and the guarantees it gives (linearizable claims, stable total
order), not by its store. A promoted daemon on SQLite is a valid hub — it is one process and one
writer, which is all the CAS requires. Postgres (or a Durable-Object-shaped host, if musterd ever
becomes a hosted service) is a valid hub. The engine is chosen when the hub is built, by the
build's own ADR if the choice proves contentious.

**Transport and credentials.** Hub links ride the ADR 040 secured bind (TLS, origin/host gates) —
that work is done. What does *not* exist is a machine credential: today's trust is bearer seat
tokens plus `isLocalPeer` (ADRs 134/170), and a second machine breaks both predicates. The
daemon↔hub credential (extending the `mskey_`/`mscr_` prefix-hash pattern to a per-machine
`msnode_` identity, its enrollment, and its revocation) is **named here, decided in a follow-on
ADR** — mirroring how ADR 039 split transport from authorization rather than deciding both badly
at once.

**Alternatives considered.**

- *Shared network DB, thin daemons* (everyone connects to one Postgres): loses offline entirely,
  adds a WAN round-trip to every seat action, and discards the working synchronous store layer.
- *Pure peer-to-peer / CRDT state* (Automerge/Yjs/Loro et al.): a CRDT cannot express "exactly one
  holder"; exclusive claims would need a quorum bolted on, at which point the CRDT is dead weight.
  The 2025–26 field evidence points the same way (teams migrating off CRDTs to
  server-authoritative sync; survey in the census page).
- *Adopt a sync product wholesale* (PowerSync was the only serious candidate — its Node SDK forks
  better-sqlite3 and its writes are server-authoritative): FSL-licensed, SDK in beta with no
  production reports under daemon workloads, imposes its own data model — and buys plumbing the
  seeds relay pattern already gives us in miniature.
- *Event-stream infrastructure as the backbone* (NATS JetStream — real revision-CAS in its KV;
  KurrentDB): adds a second stateful system, and JetStream's leaf-node story is weakest exactly at
  edge-originated writes, which is our whole workload. KurrentDB's license left OSI.
- *Named for build-time evaluation, not decided:* Electric Durable Streams (MIT, single binary,
  append-only log over HTTP with replay-from-offset) as the sync *transport*, if our own
  offset/retry/backfill code grows past a few hundred lines. It contributes nothing to claims; the
  hub CAS stays regardless.

## Consequences

- **The claim CAS is exact; its policy input is not.** The hub arbitrates displacement using the
  presence summaries daemons report upward, and presence is a heartbeat (15s refresh, 45s reap):
  the ownership decision is linearizable, but the liveness it consults is stale by up to the
  heartbeat/reap window plus sync lag. Displacement policy must tolerate that staleness explicitly
  — the build inherits this question rather than rediscovering it (ryder, #1069 acceptance).
- **ADR 039 is amended, not repudiated.** Topologies A/B remain the right answer below the
  federation threshold; `docs/design/deployment-topology.md` §8's "what this is explicitly NOT"
  unfreezes into a federation section when the build starts (that edit rides the build, per
  ADR 039's own rule that framework changes supersede by ADR).
- **Prerequisite hardening is correct today and lands now, ahead of any federation code** (own
  lane): lane ownership/state transitions become guarded transactional CAS writes
  (`WHERE`-condition + `changes === 0` conflict, per the existing `requests.ts` pattern);
  `updateLane` narrows to per-field updates; every lane transition emits a durable event, not just
  `lane.claimed`/`lane.closed`; the two `rowid` tie-breaks and the one `AUTOINCREMENT` table move
  to ULIDs. Each fix is a defect under today's single daemon too — the 2026-08-01 double-claim
  incident is the recorded cost of the current TOCTOU.
- **Not in scope here:** the machine credential ADR (named above); HLC/origin-seq schema columns
  and the sync surface itself (they land with the build); the humans-multi-presence mechanics
  (still deferred per ADR 039); any hub engine choice.
- **SPEC impact deferred:** the sync surface is daemon↔hub, not a client-visible act or envelope
  change; whether it warrants a SPEC section or stays in `docs/architecture/` is decided when the
  protocol is drafted.
- The full data census (table classification, write-path survey, landscape sources) lives in
  [the federation data census](../wiki/federation-data-census.md) — facts, dated, falsifiable,
  kept current there rather than restated here.
- _(2026-09-03)_ **Which machine is the hub** is answered by
  [ADR 376](376-the-hub-is-the-machine-the-team-was-created-on.md): the one the team was created
  on, enforced at the invite and enroll doors; relocating it is a named future increment.
- _(2026-09-03)_ **The Durable Streams re-evaluation trigger fired** (push + pull + log passed 1,000
  lines) and was answered: keep ours — the lines are mostly ingest policy the transport cannot
  carry. [Durable Streams re-evaluation](../wiki/durable-streams-reevaluation.md) has the numbers
  and the two conditions that reopen it.

## Observability & Evaluation

- **Traces:** this ADR ships no runtime; the prereq-fix lane it schedules does, and its claim-CAS
  conflicts surface as a distinct refusal (`changes === 0` → conflict error) plus the transition
  events it adds — both visible in the audit/message logs. When the sync build lands, the
  daemon↔hub cursors themselves are the trace: lag is `hub_head − daemon_cursor` per node, a
  number the status surface can print, and every applied batch is attributable to
  `(origin_node, origin_seq)`.
- **Eval:** n/a for the decision itself — no behavior changes until the build ADRs land. The
  measurable acceptance for the *prereq* slice: the concurrent-claim test pins that exactly one of
  two racing claims succeeds (dataset: the two interleavings; baseline: today's code, where both
  succeed — the 2026-08-01 double-claim is the recorded production instance).
- **Experiment:** the refuse-offline-claims choice is falsifiable in use — if partitioned machines
  routinely find lanes unclaimable at the moment work starts, the pressure will show up as asks
  and status complaints in the log, and the provisional-claim alternative this ADR rejected gets
  reconsidered with that evidence in hand.
