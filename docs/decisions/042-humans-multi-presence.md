# 042 — humans multi-presence: single-active becomes kind-scoped

- Status: accepted
- Date: 2026-06-23

## Context

ADR 039 recorded the cross-network framework and, within it, the decision that **humans may hold
multiple concurrent Presences on one seat while agents stay single-active** — but it explicitly
deferred the *mechanics* to "their own ADR when scheduled," because they touch the server
presence/delivery path and the spec's presence model (`docs/design/deployment-topology.md` §7, §10).
This ADR is that follow-on: it implements the decision, it does not re-litigate it.

The original split is "one Member, many possible Presences" (SPEC §1, glossary: *"One Member MAY have
multiple simultaneous Presences (like a person on desktop + phone)."*). v0.2's **single-active,
newest-wins** rule (ADR 010 → ADR 017) then narrowed that to *at most one* live Presence per Member,
universally. That rule exists to stop **parallel autonomous minds wearing one identity** — an agent
hazard. Applied to humans it breaks a legitimate, everyday pattern: *watching on a phone while acting
on a laptop*, simultaneously. So §4's universal single-active was actually narrower than the glossary
it serves.

## Problem

Relax single-active for humans without weakening it for agents, with the smallest correct change, and
without an envelope/act/wire change. Specifically: a second live human session must **fan out**
(attach alongside) rather than displace; both sessions must receive directed and broadcast delivery;
the roster must still render the human as **one** member; and agent behavior (newest-wins + 45s
reclaim grace) must be byte-for-byte unchanged.

## Decision

**Single-active is kind-scoped.** It applies to `kind === 'agent'` seats; human seats fan out.

- **Attach (server WS `hello`).** The displacement loop (superseded-close-evict) and the
  `clearMemberPresence` clear-then-attach now run **only for agent seats**
  (`packages/server/src/transport/ws.ts`). A human `hello` skips both: it attaches an *additional*
  presence row and `hub.add`s the new connection alongside any existing ones. Agents are unchanged —
  a fresh agent hello still takes over its own seat (the dogfood-deadlock fix, ADR 017).
- **Deliver-to-all-presences.** Already true: `hub.deliver` pushes to *all* of a member's live
  connections, and `broadcastTeam` iterates every connection — so once multiple human conns are
  allowed, both a directed `deliver` and a `@team` broadcast reach every surface. The durable inbox
  cursor still dedupes (at-least-once, SPEC §5), so a human reading on two surfaces is consistent.
- **Which presence "acts."** Sends/claims authenticate as the **seat** (the per-member token), not a
  surface, so any of a human's presences may act with no contention — there is one identity behind
  them. No change was needed here.
- **Roster.** `listPresence` already groups by member and returns one row carrying a `presences[]`
  array, so a human with N surfaces collapses to ONE member row; the array exposes the surface count
  for any client that wants it (no new field). `release`/`reapStale`/`hasLivePresence` already operate
  per-row and per-member, so a human losing one surface stays online while another is live, and the
  offline event fires only when the *last* presence drops.

**SPEC bump: none (no protocol-version change).** This is a backward-compatible *relaxation* of a
server-side constraint, not an envelope/act/wire change: no new act, no new or changed field, no new
frame. A v0.2/v0.3 client is unaffected — agents behave identically, and a human simply isn't
displaced (clients already tolerate multiple presences; the glossary always promised them). Per
AGENTS.md hard-rule 1 and SPEC §6, only **acts** or envelope-required-field changes force a
MINOR-or-greater bump; this is neither. `musterd/0.3` stays current. SPEC §4's universal single-active
prose is **edited in place to be kind-scoped**, gated by this ADR (the edit is the normative record of
the relaxation); Appendix A's future seat-occupancy lines are likewise kind-scoped so the governed
seat model stays coherent with this decision.

## Consequences

- **Humans get true multi-surface presence**; agents keep single-active + 45s reclaim grace exactly as
  before (existing ADR 017 tests stay green; an agent seat still displaces).
- **Docs updated in this commit:** SPEC §4 + Appendix A (kind-scoped), `docs/architecture/03-server.md`
  ("Single-active + reclaim grace" → kind-scoped), `docs/design/deployment-topology.md` §7/§10 (the
  open ADR item is now closed by this ADR). `deployment-topology.md` stays frozen as the *why*; this
  ADR is the spine record.
- **Tests** (`packages/server/src/transport/integration.test.ts`): two concurrent human sessions both
  `welcome`, neither `superseded`; a directed message and a `@team` broadcast both deliver to both
  human sessions; the roster lists the human once with both surfaces; the existing agent test still
  asserts displacement. Server coverage stays ≥85%.
- **Not changed:** the wire protocol, the act set, the per-member token auth, the reaper/grace
  constants, and agent single-active. No new runtime dependency.
- Cross-references: ADR 039 (parent decision), ADR 017 (newest-wins single-active),
  ADR 010 (single-active + grace), `docs/design/deployment-topology.md` §7,
  `docs/architecture/03-server.md`, SPEC §1/§4/Appendix A.
