# Deployment topology & remote transport — design (frozen; framework decided in ADR 039)

> **Status: framework DECIDED (ADR 039), secured-bind transport BUILT (ADR 040); this doc is now frozen as the durable *why*.** It designs the **networking substrate** for a team whose members live on different machines and different networks (home / office / cloud, behind NAT). It is the transport-and-reachability companion to two docs that already exist: `membership-model.md` (the shared-teams *authorization* model — seats, agent key + grants, human credentials) and `security.md` (the threat model). Those answer *who may occupy a seat once the boundary widens*; this answers *how a member on another network reaches the team at all, securely*. Topology B (overlay) is usable today (`../guides/cross-network-overlay.md`); the v0.3 credentialed remote join is still unbuilt. The local-default daemon remains `127.0.0.1`-bound and single-machine; none of this is required for v0.2 conformance.

> **Status update (2026-06-23): framework decided in ADR 039.** The topology framework below — the
> one-team-one-daemon invariant, Topology B (overlay) as the near-term answer, A (secured bind) next, C
> (relay) named-not-scheduled, and humans-multi-presence (§7) — is now a recorded decision (ADR 039),
> so this doc **freezes** as its durable *why*. The Topology B recipe is published as an operator guide:
> `../guides/cross-network-overlay.md`. Changing the framework supersedes ADR 039; don't edit decisions
> back into this doc silently.

> **Living document.** Found an error or better approach? Record it in `docs/decisions/NNN-<slug>.md`, make the smallest correct change, update this doc in the same commit.

Companions: `membership-model.md`, `security.md`, `spec-v0.3-draft.md`, `../architecture/00-overview.md` (the identity/presence/transport split), `../architecture/03-server.md` (the daemon). This is **not** federation — see §8.

## 1. Why — the gap this closes

musterd's load-bearing idea, the [identity / presence / transport split](../architecture/00-overview.md), is already **topology-agnostic**:

- A **Member** is a durable identity, not a session or a machine.
- A **Presence** is *wherever* that member is currently attached.
- The server routes each message to wherever the recipient is present; if nobody is present it lands in the durable **Inbox** (cursor-based, at-least-once — `03-server.md`).

So *conceptually* a team of "Ada on a cloud box, Lin on a laptop at the office, Nick at home" is already valid: the data model assumes nothing about co-location, and the durable inbox already tolerates the transient disconnects and partitions that are normal when members span networks. **Multiple humans per team** is likewise already designed (humans are seats; many human seats; admin/non-admin; observers — `membership-model.md`).

What is **not** designed is the substrate that makes cross-network real:

1. **Reachability.** Today every member connects to **one daemon** that defaults to `127.0.0.1:4849`. There is no story for members on three different networks, behind NAT, reaching one team.
2. **Secured remote transport.** `security.md` only gestures at this: the daemon "binds to `127.0.0.1` by default; exposing it beyond localhost … SHOULD require transport security (roadmap: TLS/authn)," and mTLS/authenticated remote transport is in its out-of-scope list.

The *authorization* half of the widened boundary is ahead of the *network* half: the v0.3 credential model (agent key + grant + human credential + audit) exists precisely for "when the daemon stops being localhost-only," but it assumes a reachable, secured transport that this doc defines.

## 2. The invariant: one team, one daemon, one authority

A musterd Team is served by **exactly one daemon** — the trusted core that holds the DB and enforces all authz (`security.md` trust boundaries). Spanning networks does **not** mean splitting the daemon or syncing databases; it means **the one daemon must live somewhere all members can reach, and members must reach it securely.** Members are always *clients* of that daemon, wherever they run. (Many daemons cooperating is *federation* — §8 — explicitly out of scope here.)

This keeps the whole existing model intact: single-active per seat, the message log as single source of truth, viewer-scoped projections, audit. We are only moving *where the daemon listens* and *how clients connect to it* — not changing what the daemon is.

## 3. Topologies (pick per team; daemon stays singular)

| Topology | Where the daemon lives | How members reach it | musterd work | When |
|---|---|---|---|---|
| **Local-only** (today) | operator's machine, `127.0.0.1:4849` | loopback only | none | v0.2; single-machine teams |
| **A. Self-hosted reachable daemon** | an always-on box / cloud VM with a routable address (or a port-forward) | `wss://host:port` direct | configurable bind + TLS (§5) | first cross-network step |
| **B. Overlay / tunnel** | any machine, joined to a private overlay (Tailscale / WireGuard / Cloudflare Tunnel / ngrok) | the daemon's overlay address | **none in musterd** — operator runs the overlay | **recommended near-term**: secure cross-NAT with zero musterd code |
| **C. musterd-operated relay** (hosted) | a hosted rendezvous service members dial out to; daemon and members both connect *out* to it | relay brokers by team | a relay protocol + hosted service | the "just works" future; largest build |

**Topology B is the pragmatic first answer** and the one to document for users immediately: an overlay network (Tailscale et al.) gives every member a stable address and mutually-authenticated, encrypted transport across NATs *without musterd implementing any of it*. We get cross-network teams by **standing on the overlay**, and only later build C for users who won't run an overlay. This mirrors Principle 4 (protocol over framework): don't reinvent WireGuard.

**Topology A** is for operators who already have a reachable host; it's the minimal *musterd-side* change (§5) and the substrate Topology C is built on.

**Topology C** is the eventual frictionless path — but it is a hosted product with its own threat model, ops burden, and cost. It is named here so we don't design A/B into a corner, not scheduled.

## 4. Reachability & NAT — why this is mostly an addressing problem

All musterd clients (CLI, MCP adapter) are **outbound WebSocket** connectors; the daemon is the only listener. That means:

- Once a client can open a TCP/WS connection to the daemon's `host:port`, everything already works — routing, presence heartbeat, durable inbox, reclaim grace. There is no peer-to-peer or inbound-to-client requirement.
- So the hard part is **making the daemon's host reachable** from each member's network, not punching holes to every client. NAT traversal collapses to: give the daemon a reachable address (A), or put everyone on one overlay (B), or have both sides dial out to a broker (C).
- This is why B is cheap: the overlay solves daemon reachability *and* encryption *and* authentication in one move.

## 5. Secured remote transport (the musterd-side work for Topology A)

Principle 7 (secure by default) means widening the bind is a deliberate, guarded step, never an accident. Concretely, when the daemon listens beyond loopback:

- **TLS required off-loopback.** The daemon MUST refuse to bind a non-loopback address without TLS configured — either native TLS termination (cert/key paths in config) or an explicit `--insecure-trust-proxy` acknowledging a TLS-terminating reverse proxy in front. Clients use `wss://` / `https://`. No plaintext WAN transport, ever.
- **Configurable bind, loopback default.** `MUSTERD_HOST` already exists; the new rule is the *guard* above, plus startup logging of the effective bind + scheme so "what is this daemon exposing?" is answerable (extends the `03-server.md` / ADR 016 diagnostics posture).
- **Credentials ride the secured channel.** This is where v0.3 plugs in: over `wss://`, the **agent key** authenticates the harness, the **grant** authorizes occupying a seat, and a **human credential** authenticates a human seat (`membership-model.md`, `spec-v0.3-draft.md` §2). Transport security (this doc) and occupancy authorization (membership model) are the two factors of a safe remote join — neither substitutes for the other.
- **Origin / Host checks** on the WS upgrade to blunt cross-site and DNS-rebinding abuse of a now-exposed daemon.
- **Out of scope even here:** mTLS client certs, encryption-at-rest for the DB, rotating per-seat keys — all already on `security.md`'s roadmap list; named so A doesn't preclude them.

## 6. Resilience across networks (mostly already handled — confirm, don't rebuild)

WAN links drop; this is the normal case, not the exception. What already covers it, and the small deltas:

- **Durable inbox + cursor** = partition tolerance for free. A member offline during a partition re-reads everything missed via `inbox_cursors.last_read_ts` on reconnect (`03-server.md`). No message is lost to a dropped link. ✅ no change.
- **Reclaim grace (45s `held_until`)** already makes a flaky reconnect seamless — the *same* member rejoins its seat without being refused (ADR 010/017). Over a high-latency/lossy WAN this matters more, so the grace window and the `PRESENCE_TIMEOUT_MS` / `HEARTBEAT_INTERVAL_MS` constants may need to be **tunable** rather than hardcoded for cross-network teams. (Delta: config, not architecture.)
- **Newest-wins single-active (ADR 017)** interacts with bad networks: a client that *looks* dead but isn't can be displaced by its own reconnect — which is the intended self-heal, not a bug. Worth a test at WAN latencies.
- **Client reconnect/backoff** in the CLI and MCP adapter should be explicit and bounded (the displaced adapter still treats `superseded` as terminal — no ping-pong).

## 7. Multi-network humans — decided: humans multi-presence, agents single-active

A human is a seat, claimable from any machine with their human credential — so "the same human at home and at the office" is just one seat claimed from different networks. But **single-active per seat** (designed for agents, to stop "many minds, one identity") collides with a real, legitimate human pattern: *watching on a phone while acting on a laptop*, simultaneously.

**Decision (confirmed):** **humans may hold multiple concurrent Presences on one seat; agents stay single-active.** The single-active rule exists to prevent *parallel autonomous minds* — an agent hazard, not a human one. A person watching on a phone while acting on a laptop is exactly the humans-as-peers experience musterd is for, and it matches the original split ("one Member, many possible Presences"). So the single-active displacement (newest-wins, ADR 017) is **kind-scoped**: it applies to agent seats; human seats fan out instead.

The mechanics are now built and recorded in **ADR 042** (single-active becomes kind-scoped in the
server's presence/delivery path and in SPEC §4 / Appendix A):
- **Deliver-to-all-presences** for a human seat (every live surface gets the push; the durable cursor still dedupes).
- **Which presence "acts"** — sends/claims attribute to the seat, not a surface, so any of a human's presences may act; no contention because there's one identity behind them.
- **Roster rendering** of a human with N surfaces (collapse to the seat; the `presences[]` array carries the surfaces).

This is the one item in this doc that ripples into the spec's presence/claim model (SPEC §4 +
Appendix A, via ADR 042) rather than being pure transport.

## 8. What this is explicitly NOT

> **Unfrozen 2026-08-27 — federation is being built.** ADR 039's "not federation" line was superseded in part by [ADR 325](../decisions/325-multi-machine-federation.md), which relocated the invariant from *one daemon* to **one team, one authority**: a team is served by one **hub** and any number of **machine daemons** (replicas), with a single-machine team as the degenerate case where its one daemon is its own hub. ADR 325 §Consequences said this section unfreezes "when the build starts". It has — see §11 below. Everything else in this section still holds as written, and the topologies of §3 remain the right answer for any team that fits on one daemon.

- ~~**Not federation.**~~ Superseded — see the note above and §11. Team-to-team addressing and cross-team identity remain a separate roadmap item (`ROADMAP.md`, ADR 001); a member still belongs to one team.
- **Not multi-region / HA / replicated DB.** One daemon, one SQLite store remains the model. Scaling the daemon itself (replication, failover) is a later, separate concern.
- **Not running members.** Reachability ≠ hosting. A member on a cloud box is *run* by whoever owns that box; musterd connects it (Principle 4). The optional sandboxed runtime (`ROADMAP.md`) is the only place musterd hosts a member, and it's unrelated to this doc.

## 9. Phasing

1. **Document Topology B now** (overlay/tunnel) — a docs-only deliverable that makes cross-network teams *possible today* with no musterd code, by standing on Tailscale/WireGuard. Highest value per effort. ✅ **done** — decided in ADR 039, published as `../guides/cross-network-overlay.md`.
2. **Topology A: secured bind** (§5) — the off-loopback-requires-TLS guard, `wss://` client support, Origin/Host checks, tunable timeouts (§6). ✅ **transport built** in ADR 040 (the guard, native TLS, Origin/Host gate, env-tunable timeouts). The credentialed remote join it carries is still the v0.3 credential model; the bind ships ready for it.
3. **Topology C: hosted relay** — a rendezvous service and protocol so neither side needs a reachable address or an overlay. Largest build; its own threat model and ops. Named, not scheduled.

## 10. Open questions

- ~~Single-active vs. multi-presence **for humans** across machines~~ — **decided** (§7: humans multi-presence, agents single-active) **and built** (ADR 042: kind-scoped single-active — agent seats displace, human seats fan out, deliver-to-all-presences, roster collapse; no protocol-version bump).
- ~~Native TLS in the daemon vs. "always run a reverse proxy / overlay" as the documented stance~~ — **decided** (ADR 040): support **both** — native in-process TLS (`MUSTERD_TLS_CERT`/`MUSTERD_TLS_KEY`) *and* `--insecure-trust-proxy` for a TLS-terminating proxy/overlay in front; either satisfies the off-loopback guard.
- ~~Heartbeat/grace/timeout constants: WAN-tuned defaults vs. per-team config (§6)~~ — **decided** (ADR 040): env-overridable per team, today's values kept as defaults (no behavior change out of the box).
- Does Topology C reuse the same wire protocol end-to-end (relay is a dumb pipe) or introduce a relay-specific framing? Prefer the former.

## 11. Federation (ADR 325) — the build, and where it has got to

Added 2026-08-27, unfreezing §8's first bullet. This section tracks the shape actually built; the
decisions themselves live in the ADRs it names.

**The topology.** One team, one **authority**. A team is served by one hub and any number of machine
daemons. A machine daemon is today's daemon unchanged in kind — same store, same clients, same
synchronous SQLite; the hub is the same daemon *promoted*, additionally speaking the sync surface and
arbitrating the facts that need global agreement. A single-machine team is the degenerate case and
nothing about today's deployment changes ([ADR 325](../decisions/325-multi-machine-federation.md)).

**Three residences for state**, decided by consistency need: hub-authoritative under linearizable CAS
(lane ownership, canonical order, admission of remote daemons); locally-authoritative and replicated
(messages and the other append-only events); local-only and never replicated (presence, wake leases,
footprint, schema meta — and `local_node`, below). Roster identity stays on git, unchanged
([ADR 058](../decisions/058-durable-on-git-live-on-daemon.md)).

### Increments

| # | What | Status |
| --- | --- | --- |
| 1 | Prereq hardening — guarded lane CAS, per-field `updateLane`, transition events | landed (#1071) |
| 2 | The ordering substrate — `(origin_node, origin_seq)` stamped from the first message, migration v47 | landed 2026-08-27 (`5c1b35f0`, [ADR 331](../decisions/331-ordering-substrate.md)) |
| 3a | The machine credential — `msnode_`, `msinv_` enrollment, rotation, revocation | landed 2026-08-28 (#1100, `3b8415cf`, [ADR 328](../decisions/328-machine-credential.md)) |
| 3b-i | Sync wire format and push — `sync_log` staging under a canonical `hub_seq` | landed 2026-08-31 (`46707cb5`, [ADR 335](../decisions/335-sync-wire-format.md)) |
| **3b-ii** | **Pull by cursor, the fold into `messages`, read-side gap detection; the hub stages its own history** | **this build** (migration v52, spec `docs/superpowers/specs/2026-09-01-sync-fold-design.md`) |
| 3c | Hub-authoritative claim CAS, seat→node residence binding | not started — needs this increment plus a lane-replication slice (its lane's declared dep on 3a alone is wrong) |

The hub storage engine needs no decision: ADR 325 defines a hub by the surface it speaks, and a
promoted daemon on SQLite satisfies the CAS — one process, one writer.

### What increment 3a added

- **A node is a machine-*team* principal.** A daemon hosting two teams is admitted separately at two
  hubs, revocable separately at each, and holds two identities with two independent `origin_seq`
  streams (ADR 331 §Decision 1).
- **Enrollment is a one-time code.** An admin runs `musterd node invite` on the hub for a single-use,
  15-minute `msinv_`; the joining machine runs `musterd node join <hub-url> <code>`. That command
  asks **its own daemon** to enroll — the daemon presents the node id it already holds from v47, and
  writes the durable `msnode_` to `~/.musterd/node.json` at 0600. The CLI never holds the credential.
- **The hub binds, and can refuse.** Consuming the invite and binding the credential are one
  transaction, so a refused bind does not spend the operator's code. Two refusals: an id already
  bound to a different credential, and **any id in `local_node`** — a hub never enrolls with itself,
  so its own row is permanently unbound and would otherwise be bindable by a joiner, who could then
  stamp events as the hub.
- **`local_node`** (migration v48) records which `nodes` row is this daemon's. Increment 2 identified
  it by `ORDER BY id LIMIT 1`, correct only while there was one row per team — which enrollment is
  precisely what ends.
- **An `msnode_` admits its bearer to the sync surface and nothing else** (ADR 328 §3). It is not a
  seat credential: a machine being *admitted* and a seat being *authorized* are independent axes.

### What increment 3b-i added

- **Events reach the hub.** An enrolled daemon pushes its own origin-stamped messages to
  `POST /teams/:slug/sync/push` on a 60s loop. The hub stages them in **`sync_log`** (migration v50)
  under a per-team **`hub_seq`** — the canonical total order, assigned in order of *ingest*, not of
  `ts`: wall-clock across machines is exactly what [ADR 331](../decisions/331-ordering-substrate.md)
  §Context says cannot be trusted, while arrival at the one authority is a fact that authority
  observed.
- **The replicated event is the `Envelope` plus its origin stamp**, not a parallel message shape.
  The wire names its sender by **seat name**: `messages.from_member` is a daemon-private anchor, and
  shipping it would dangle on the receiver or resolve to a different seat holding that id there.
  `from_provenance` travels (an attested fact about the event); `created_at` deliberately does not
  (local receipt time — shipping the origin's would assert a falsehood about when this machine
  learned of the event).
- **Two refusals at ingest.** A batch whose origin is not the authenticated node is `403`; a batch
  that does not continue the origin's sequence is `409` carrying `expected_seq`, so a pusher can
  resume rather than retry a rejected batch forever. Both roll the whole batch back — a partially
  applied batch leaves a hole the pusher believes it has closed.
- **The push cursor advances only past an ACKED batch.** A cursor moved on send would turn every
  unreachable hub into permanent silent loss. Offline is the expected state for a laptop, not an
  error: the pass logs `sync_push_failed` and retries next tick.

### What increment 3b-ii added

- **Events apply remotely.** A joiner pulls `GET /teams/:slug/sync/pull` by `hub_seq` cursor and
  folds foreign-origin events into its own `messages`; the hub folds joiner events from its own
  `sync_log`. One implementation (`sync/fold.ts`), two feeders. The fold copies the origin stamp
  verbatim and never touches `nodes.next_seq` — `insertMessage` remains the only allocator.
  `created_at` on a folded row is *this* machine's receipt time, never the envelope's `ts`.
- **The hub's own history is in the log it serves.** A hub never enrolls with itself, so before this
  its own traffic never reached `sync_log`; now it pushes to itself in-process through `ingestBatch`
  once a joiner is enrolled, backfilling through the same gapless path. A hub that has never sent
  still folds — hosting is defined by who is enrolled with it, not by whether it has spoken.
- **The fold blocks, never skips.** An event naming a seat this roster does not yet hold (git lag),
  an act this build does not know, an envelope id already held under another origin, or an
  origin-sequence gap stops the cursor *at* that event with its own `error` line, once per distinct
  blocker; the prefix is applied. Roster and build stalls clear themselves; the other two are
  terminal.

### Not yet true

**Folded events are not pushed to open sockets.** They are in `messages`, so inbox reads see them;
live WebSocket delivery of a remote event is a follow-up. **The inbox and wake cursors still key on
`ts`** — the origin's clock — so a folded event older than a seat's last read is invisible to that
seat; the readers move to `created_at` in their own lane, a hard precondition before a second
machine enrolls (spec §"The ts-cursor defect"). **Lanes, goals and audit do not replicate**
(ADR 331 §Decision 5), so lane claims stay local until 3c — which now has what it was missing.
