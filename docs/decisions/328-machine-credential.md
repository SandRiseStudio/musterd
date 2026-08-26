# 328 — the machine credential: an `msnode_` identity per daemon, enrolled once, revocable at the hub

- Status: accepted — 2026-08-25 (ryder PASS on #1077 with one required amendment to decision 4:
  residence is a hub-minted binding, not a reading of ADR 131 residency records — applied). Authored
  by stanley on lane `01M0Y3H7HMWEWGA6QE1Y2ZRT4A`, as the first increment of the ADR 325
  federation build.
- Date: 2026-08-25
- Builds on: [ADR 325](325-multi-machine-federation.md) (which named this ADR and deferred the
  decision to it), [ADR 040](040-secured-off-loopback-bind.md) (the secured bind the sync surface
  rides — transport is done, this is the authorization half),
  [ADR 134](134-provisioning-is-localhost-trust-enforced.md) (`isLocalPeer`, the predicate a second
  machine breaks), [ADR 170](170-signin-handoff.md) (the "walk them through it, never make them
  paste a long-lived secret" posture this reuses),
  [ADR 076](076-v0.3-p3-1-credential-grant-substrate.md) /
  [ADR 069](069-v0.3-governance-build-plan.md) (the `mskey_`/`mscr_` prefix-hash substrate this
  extends), [ADR 058](058-durable-on-git-live-on-daemon.md) (roster identity on git — why the hub
  cannot validate a seat token directly), [ADR 131](131-harness-residency-wake-ledger-host.md) (host
  identity and the three machine-local stores this adds a fourth to),
  [ADR 101](101-model-as-a-variable.md) / [ADR 158](158-model-attestation-truth.md) (per-event
  attestation, the reason `origin_node` must name a principal and not a label)
- Lane: `01M0Y3H7HMWEWGA6QE1Y2ZRT4A`

## Context

[ADR 325](325-multi-machine-federation.md) decided the federation topology — one team, one hub
authority, per-machine daemons as replicas syncing an append-only event log — and deliberately did
not decide how a daemon proves to a hub that it is who it says it is. It named the gap precisely:

> today's trust is bearer seat tokens plus `isLocalPeer` (ADRs 134/170), and a second machine breaks
> both predicates. The daemon↔hub credential … is **named here, decided in a follow-on ADR** —
> mirroring how ADR 039 split transport from authorization rather than deciding both badly at once.

This is that ADR. Three facts about the codebase set its shape.

**Every principal musterd has is a seat or a team.** The token registry
(`packages/protocol/src/credentials.ts`) holds four kinds — `mskd_` seat, `mskey_` team agent key,
`msgr_` grant, `mscr_` human credential — and all four answer "who is acting", never "which machine
is speaking". There is no principal in the system that *is a machine*.

**Machine identity exists, but only as a routing label.** ADR 131's residency path carries a `host`
string, enrolled server-side and mirrored into `~/.musterd/host-registry.json` alongside the seat →
workspace map. That label is self-asserted and unauthenticated; the registry's own header says so —
"No secrets live here". It tells a wake where to spawn. It cannot tell a hub whom to believe.

**The existing secret substrate is good and should be extended, not replaced.** The prefix registry
is protocol-side, but the minting is not: `newSecret(prefix)` — `prefix + base64url(randomBytes(24))`
— and `hashToken` both live in `packages/server/src/store/members.ts`, which is where a fifth kind
gets minted too. `hashToken` stores only the sha256 hex; the plaintext is returned exactly once and
never logged or re-fetchable (SPEC A.2). That scheme has carried four kinds without incident. A
fifth costs a registry entry and a column.

## Problem

Decide the identity, enrollment, authorization scope, rotation, and revocation of the daemon↔hub
machine credential — such that an admitted machine can sync and can act for the seats that live on
it, a compromised machine cannot act as the whole team, and a machine can be removed without
re-keying everyone else. Without deciding the hub storage engine, the sync wire format, or anything
ADR 325 left to the build.

## Decision

**1. A node is a principal.** A fifth token kind joins the registry — `node: 'msnode_'` — minted and
stored exactly like its four siblings (`newSecret` + `hashToken`, plaintext shown once). The hub
gains a `nodes` table: ULID `id`, `team_id`, human-readable `label`, `credential_hash`,
`enrolled_at`, `enrolled_by`, `revoked_at`, `last_seen_at`.

The `origin_node` half of ADR 325's `(origin_node, origin_seq)` ordering pair **is this row's id**.
The ordering substrate and the credential name the same principal on purpose: an event's origin is
then a fact the hub authenticated at ingest, not a string the sender chose. Provenance that a sender
can pick is not provenance, and ADRs 101/158 stamp attestation per event at insert precisely so it
survives replication — it survives to mean something only if its origin is checked.

**2. Enrollment is a one-time code, not a copied secret.** An admin on the hub runs `musterd node
invite`, which mints a short-TTL (15 minutes), single-use `msinv_` enrollment code. The joining
daemon runs `musterd node join <hub-url> <code>` and receives its durable `msnode_` credential,
shown once, written to machine-local state (`~/.musterd/node.json`, mode 0600) — never into a
workspace, never into the repo.

This is trust-on-first-use bounded by a short window, and it is the ADR 170 posture applied one
level down: that ADR refused to make a human paste a long-lived `mscr_` into a field, and a node
credential is longer-lived than any credential the system currently issues. The invite is itself a
bearer secret with identical handling, and **its consumption is a guarded CAS write** — `UPDATE …
WHERE consumed_at IS NULL`, `changes === 0` is a refusal — the same pattern the ADR 325 prereq slice
(#1071) landed for lane claims. Two daemons racing one invite must not both enroll.

**3. The node credential authorizes the sync surface and nothing else.** It admits its bearer to
exactly three things: push origin-stamped events, pull the merged log by cursor, and submit
hub-authoritative claim CAS requests. It is not a seat credential. It cannot claim a seat, read
messages as a member, or raise an act. A machine being *admitted* and a seat being *authorized* are
independent axes, and collapsing them would make one laptop's compromise a licence to mint
teammates.

**4. An admitted node speaks for the seats resident on it — and only those.** This is the sharpest
choice in the ADR, and it is forced by ADR 058. Roster identity replicates via git, but
`token_hash` does not: ADR 325 keeps `id`/`token_hash` as daemon-private anchors. So the hub
**cannot** validate a seat token directly, and only two designs remain: replicate seat token hashes
to the hub, or let the admitted daemon attest which of its local seats is acting.

We take the second. Replicating token hashes would widen the blast radius of a hub compromise from
"the coordination log" to "every seat credential on the team", to buy a check the daemon is already
trusted to make — today's daemon is the sole validator of its local seats' tokens, and federation
does not make it less so. The hub therefore enforces **residence**, not authentication. The daemon
is a carrier for its own residents, never a delegate for the team.

**Residence is a hub-minted binding, not a reading of the residency records.** This distinction is
load-bearing and the ADR would be wrong without it. ADR 131's residency enrollment cannot carry the
weight for two independent reasons: it is **opt-in per seat** ("Residency is opt-in per seat, and
enrollment is the authorization event", ADR 131 §2), so for every seat that never ran `residency on`
the predicate would have no input at all — undefined in the common case, not merely stale; and the
host registry that holds it is machine-local by design — "the store the daemon must never hold"
(`packages/cli/src/host/registry.ts`) — so the hub structurally cannot read it. §Context above says
that label "cannot tell a hub whom to believe", and it must not be quietly promoted three decisions
later into the thing that does.

So the hub mints the binding itself: **seat X binds to node N the first time N speaks for X**,
first-writer-wins under the same guarded CAS as the `msinv_` consumption, with re-binding requiring
an explicit act rather than a silent overwrite. Three properties follow, and each is one the
residency-record version lacked. The binding is *authenticated* — it is written under an admitted
node credential, never asserted by a self-declared label. It is *complete by construction* — there
is no enrollment gap, because the first claim is the enrollment. And it makes a refusal *mean*
something: "this seat is bound to another node", a fact the hub owns, rather than "no residency row
exists", which is indistinguishable from a seat that simply never opted in.

The honest consequence is stated rather than buried: *compromise of a node credential is the ability
to act as the seats resident on that machine.* That is a real and bounded loss, it is the same
authority the machine's own daemon already holds locally, and it is strictly smaller than the
alternative.

**5. Rotation keeps the node; revocation keeps the history.** `musterd node rotate` mints a fresh
`msnode_` against the same node row — the id, and therefore every `origin_node` stamp in the log, is
stable across credential changes. This is why the node id is a ULID on the row and is never derived
from the credential.

`musterd node revoke` sets `revoked_at`; the hub refuses push, pull, and claim from that node
immediately. **Events already ingested stay.** The log is append-only and those events are attested
history; revoking a credential is not retro-repudiating what was said under it. Revocation is itself
an audited verb (`node.revoked`), so the removal is in the record. Lanes held by that node's seats
are **not** auto-released — a cascade would close work on a human's judgement-free timer; releasing
them stays the ordinary human-made act.

**6. `isLocalPeer` is not weakened.** The localhost-trust routes of ADRs 134/170 keep their gate
exactly as it stands. The sync surface is a *new* set of routes that `isLocalPeer` never guarded,
authenticated by `msnode_` over the ADR 040 secured bind. Nothing that is localhost-only today
becomes remote-reachable because of this ADR — a property worth naming, since ADR 134 exists because
that boundary was once assumed rather than checked.

**7. Inert until a second machine appears.** A single-machine team is ADR 325's degenerate case: its
daemon is its own hub, the `nodes` table is empty, no `msnode_` is ever minted, and no route
changes. Enrollment is something you do when you add a machine, not something today's deployment
starts doing.

## Alternatives considered

- **Reuse the team agent key (`mskey_`) as the machine credential.** It is per-team and already on
  every machine, so it looks free. Rejected on three counts: it is a *team* secret, so every holder
  is indistinguishable from every other and `origin_node` attribution becomes unfalsifiable; it
  cannot be revoked per-machine (rotating it re-keys the whole team); and it already sits in every
  workspace's `.musterd/binding.json`, which is the widest distribution of any secret in the system.
  A machine credential must be exactly as narrow as the machine.
- **Asymmetric keypair (ed25519); the node signs each event.** This is really two upgrades, and they
  should be priced separately rather than sold as one. *Replacing the credential* — the hub holds a
  public key instead of a hash, and so holds nothing that can impersonate a node — is cheap and
  stays open: decision 5 keeps the node id stable across credential *form*, so a public key replaces
  the bearer hash on the same row without disturbing a single `origin_node` stamp in the log.
  *Making ADR 101/158 attestation cryptographic rather than declarative* is the larger half and is
  not bought by the first: it needs a signing envelope over each replicated event and verification
  on every applied row, which is a wire change in increment 3's territory. Both are rejected here
  *for sequencing, not on merit* — neither is foreclosed by starting with a bearer secret, and a
  later reader should not budget the second at the price of the first.
- **mTLS client certificates.** The ADR 040 bind could carry them. Rejected: a CA and its rotation
  is more operational apparatus than a personal-scale team will run, and it puts the identity in the
  transport layer, where the application cannot see it at the moment it needs to stamp
  `origin_node`.
- **Declare nodes in the git roster (no secret).** Appealingly consistent with ADR 058. Rejected: a
  declared node with no secret is an authorization that anyone with push access grants themselves.
  Roster identity answers "who is on this team"; it structurally cannot answer "prove you are this
  machine."
- **Derive residence from ADR 131's residency records** rather than minting the binding at the hub.
  This is what an earlier draft of this ADR said, and it is wrong twice over (ryder, #1077 review):
  residency is opt-in per seat, so the predicate is *undefined* for every seat that never enrolled —
  the common case, not an edge — and the host registry holding it is machine-local by design, so the
  hub cannot read it at all. Recorded rather than silently fixed because the mistake is an attractive
  one: the records look like exactly the right fact, and they are, for the wake path they were built
  for.
- **No machine credential — rely on the secured bind and network reachability.** This is the status
  quo's implicit model (`isLocalPeer`) generalized to "whoever can reach the port". Rejected on
  exactly the grounds ADR 134 rejected it once already: an emergent property of the bind is not a
  checked predicate, and the last time musterd assumed otherwise it was an anonymous observer mint.

## Consequences

- **Stated blast radius.** A leaked `msnode_` lets its holder act as the seats resident on that
  machine and read the team log the hub would hand that machine anyway. It does not let them act as
  any other machine's seats, admit further machines, or mint credentials. Rotation is a
  single-command remedy that costs no history.
- **A fifth secret kind carries the fourth's obligations.** `team export` must not serialize node
  rows, CLI display masks the credential to its prefix, and the audit `detail` never carries
  plaintext — the same handling already specified for `ask_slack_webhook` and `seeds_relay_token`.
  This is a checklist item on the build, not a new discipline.
- **A fourth machine-local store.** ADR 131's contract doc names three (daemon SQLite, workspace
  `.musterd/binding.json`, `~/.musterd/host-registry.json`). `~/.musterd/node.json` is the fourth,
  and unlike the host registry it *does* hold a secret — the three-stores table and its "no secrets
  here" line need the amendment, and that edit rides this build.
- **This ADR makes the guarded-write pattern a third and fourth instance**, after the lane claim
  #1071 landed: the `msinv_` consumption and the seat→node binding. Three was the threshold this
  ADR's own draft named for extracting a shared helper, and the build should take it rather than
  hand-roll `changes === 0` twice more.
- **Node identity is per-enrollment, not per-machine.** A revoked machine that later re-enrolls gets
  a new node row, so one physical machine becomes two origins with two independent `origin_seq`
  streams, the older frozen mid-history. Nothing breaks — a new origin is a legitimate origin, and
  the frozen stream stays valid history — but anything reasoning *per machine* (`last_seen_at`, a
  future "which machines are still syncing" view) will count that machine twice. Correlating the two
  is a reporting concern, deliberately not an identity one: collapsing them would mean a stable
  machine fingerprint, which is a second identity substrate this ADR declines to invent.
- **Residence is a sturdier input than the one ADR 325 worried about.** That ADR flagged the hub
  arbitrating on presence summaries stale by the heartbeat/reap window plus sync lag. A hub-minted
  binding is not stale in that way at all — it is a fact the hub wrote itself, under CAS. What it
  can be is *out of date with the human's intent*: a seat whose operator has moved to another laptop
  is bound where it last spoke, which is exactly the case the Experiment below watches.
- **Not in scope:** the sync wire format and its routes (ADR 325 increment 3), the hub storage
  engine, humans-multi-presence (still deferred per ADR 039), and cryptographic per-event
  attestation (the larger half of the keypair upgrade above). Re-binding a seat to a new node *is*
  decided here — it is an explicit act, never a silent overwrite — but its ergonomics (who may call
  it, whether it needs the losing node's cooperation) wait on the Experiment, which is what will say
  whether it is a rare administrative repair or an everyday move.

## Observability & Evaluation

- **Traces:** enrollment, rotation, and revocation are audited verbs (`node.enrolled`,
  `node.rotated`, `node.revoked`) carrying actor and node label and never the secret. A push, pull,
  or claim refused for an unknown, unenrolled, or revoked node returns a *distinct* error code from
  an ordinary auth failure, so a mis-enrolled machine is diagnosable from the hub's log rather than
  from silence — the failure mode a TOFU pairing flow actually produces in the field. `last_seen_at`
  per node makes "which machines are still syncing" a query rather than an inference from lag —
  read per enrollment, not per machine, per the identity consequence above. The seat→node bindings
  are themselves the residence trace: the table answers "where does the hub believe this seat
  lives", which is the question every residence refusal will provoke.
- **Eval:** two races, one pattern. **(i)** The invite race — two daemons redeeming one `msinv_` code
  concurrently, exactly one enrolls (dataset: the two interleavings; baseline: the unguarded
  read-then-write, where both enroll, which is the 2026-08-01 double-claim defect in a new place).
  **(ii)** The binding race — two nodes speaking for the same unbound seat concurrently, exactly one
  binds and the other is refused with the distinct code above. Both are the same guarded CAS under
  test, which is the argument for the shared helper rather than a third hand-rolled `changes === 0`.
  Third pinned case, not a race: a claim from a node the seat is not bound to is refused.
- **Experiment:** decision 4's residence binding is the falsifiable choice, and the hub-minted form
  makes the signal legible in a way the residency-record form could not. If seats legitimately move
  between machines often enough for first-writer-wins to bite — refusals landing at exactly the
  moment someone resumes a seat on a different laptop — the evidence is a run of refusals naming a
  *bound-elsewhere* node, followed by an explicit re-bind. That pair is unambiguous, where "no
  residency row" would have been indistinguishable from a seat that simply never opted in. A
  sustained run is the signal to add an explicit seat-migration act; writing it down now is what
  makes that a deliberate relaxation rather than a quiet loosening the first time it is inconvenient.
