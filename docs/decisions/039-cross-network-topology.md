# 039 — cross-network teams: one team is one daemon, reached over an overlay first

- Status: accepted
- Date: 2026-06-23

## Context

musterd's identity / presence / transport split (`docs/architecture/00-overview.md`) is already
topology-agnostic: a Member is a durable identity, a Presence is wherever it's currently attached, and
the durable Inbox (cursor-based, at-least-once) already tolerates the disconnects and partitions that
are normal when members span networks. So a team whose members live on three different networks is
*conceptually* already valid. What was missing was the **substrate**: how a member behind NAT on
another network reaches the one daemon at all, and how that link is secured.

`docs/design/deployment-topology.md` worked this out in full — the invariant, the topology table, the
secured-bind work, the resilience deltas, the humans-multi-presence decision, the phasing. It is a
design doc, and per AGENTS.md design docs hold durable *why*, not decisions. The framework it lands is
now decided and load-bearing for v0.3 (the whole governance set in `security.md` / `membership-model.md`
is gated on the daemon leaving localhost, ADR 007), so it needs to be a **decision on the spine**, not
only a proposal in a design doc. This ADR records that framework so the design doc can freeze and the
execution slices (the operator guide now; the secured bind next) have a decision to cite.

## Problem

Make "a team across machines and networks" a recorded decision — its invariant, its near-term answer,
and the order of the work — without prematurely committing to the largest builds (hosted relay) or
pulling the v0.3 credential model forward. The two halves of a safe remote join (secured *transport*
and occupancy *authorization*) must stay distinct: this decision is about transport and reachability,
not credentials.

## Decision

**The invariant: one team, one daemon, one authority.** A Team is served by exactly one daemon — the
trusted core that holds the DB and enforces all authz. Spanning networks does **not** split the daemon
or sync databases; it means the one daemon must live where all members can reach it, and members reach
it securely as *clients*. Single-active per seat, the message log as source of truth, viewer-scoped
projections, and audit all stay intact — we move only *where the daemon listens* and *how clients
connect*, never *what the daemon is*. (Many cooperating daemons is **federation** — explicitly out of
scope, `deployment-topology.md` §8, ROADMAP/ADR 001.)

**Three topologies, daemon stays singular** (`deployment-topology.md` §3):

- **B. Overlay / tunnel is the near-term answer** and the one we document for users now. The operator
  runs the daemon on a machine joined to a private overlay (Tailscale / WireGuard / Cloudflare Tunnel);
  every member sets `MUSTERD_SERVER` to the daemon's overlay address. The overlay supplies cross-NAT
  reachability **and** encryption **and** mutual authentication, so **musterd writes none of it**. This
  is Principle 4 (protocol over framework): don't reinvent WireGuard. Cross-network teams become
  possible *today*, with zero musterd code.
- **A. Self-hosted reachable daemon (secured bind)** is the next musterd-side step: a configurable
  off-loopback bind that *requires* TLS, `wss://` clients, Origin/Host checks, and tunable resilience
  timeouts (`deployment-topology.md` §5–§6). It pairs with the v0.3 credential model and ships when
  shared teams ship. Its guard predicate and TLS stance are decided in a follow-on ADR.
- **C. musterd-operated hosted relay** is the eventual frictionless path (neither side needs a
  reachable address or an overlay) — a hosted product with its own threat model, ops, and cost. It is
  **named, not scheduled**, so A and B aren't designed into a corner.

**Humans multi-presence, agents single-active — decided; mechanics deferred.** A human seat may hold
multiple concurrent Presences (watch on a phone while acting on a laptop); agent seats stay
single-active (newest-wins, ADR 017). The single-active rule exists to stop *parallel autonomous
minds* — an agent hazard, not a human one (`deployment-topology.md` §7). This is decided, but its
**mechanics** (deliver-to-all-presences for human seats, kind-scoped single-active, roster rendering)
touch `spec-v0.3-draft.md` and the server presence/delivery path, so they get **their own ADR when
scheduled**. Nothing in this decision changes single-active behavior today.

**Transport ≠ authorization.** This decision governs reachability and the secured channel. The
credentialed remote join (agent key + grant + human credential authenticating *over* that channel) is
the v0.3 governance model (`membership-model.md`, ADR 007) and is **not** decided here — A builds the
transport the credentials will later ride, not the credentials.

## Consequences

- **`deployment-topology.md` freezes** as the durable *why* behind this decision; its §9 phasing is
  ticked as Topology B is documented (this slice). Future changes to the framework supersede this ADR,
  not edit the design doc silently.
- **A cross-network team works today over an overlay with zero musterd code** — the operator guide
  (`docs/guides/cross-network-overlay.md`, the precedent-setting first guide) is the execution-ready
  half of this decision and ships with it.
- **No SPEC / protocol-version bump.** This is deployment and transport framing, not an
  envelope / act / wire-format change. The secured-bind rule (Topology A) likewise lives in
  `security.md` + `03-server.md`, not SPEC — confirmed in the follow-on bind-guard ADR.
- **The work order is recorded:** B (docs, now) → A (secured bind, with v0.3) → C (relay, named not
  scheduled). Federation, multi-region/HA, mTLS client certs, and encryption-at-rest stay out of scope
  (`security.md` roadmap list, `deployment-topology.md` §8).
- Cross-references: `docs/design/deployment-topology.md`, `docs/design/security.md` (Principle 7,
  off-loopback line), `docs/design/membership-model.md`, ADR 007 (v0.3 scope cut), ADR 017
  (newest-wins single-active).
