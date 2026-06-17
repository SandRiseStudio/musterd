# 021 — driver co-presence: name the human steering an agent

- Status: accepted
- Date: 2026-06-17

## Context

`human-agent-dynamics.md` §1 names the founding dogfood wound: when a human steers an agent inside its session (the **driving** posture), the roster shows the agent `online` and the human `offline` — the one entity certainly present shows as gone. The agent holds the only socket in the room; the human attaches only when they explicitly `inbox --watch` (the **supervising** posture).

This is now evidence-backed, not just an aesthetic complaint. `research-foundation.md` records the Co-Gym result (arXiv:2412.15701): in real trials humans **co-act 21–32% of the time** — they directly edit the shared workspace, they are participants, not spectators. So the roster is not merely unflattering in the driving posture; it is **lying about a measured participant**. And it is the pre-launch gate for the real 3-pane demo (`implementation-plan.md` §4.A0 item 1 / §4.B): the launch headline is "humans and agents as peers," which the product cannot show honestly while the driving human renders absent.

ADR 014 already shipped the lighter first cut it anticipated: `provenance: session` on a presence says "*someone* is behind this." This ADR closes the named-human half of the same seed (`human-agent-dynamics.md` §54, "driver co-presence").

## Problem — three candidate mechanisms

§54 left the *mechanism* open: a paired presence row vs. a richer provenance render.

- **Option A — a second presence row attributed to the human** (`nick — driving Tim`). Truthful, but the adapter authenticates **as the agent** (it holds the agent's token) and does **not** hold the human member's identity or token. Emitting presence *as the human* would require the human's token or a server-side linkage between members — i.e. either making the adapter impersonate the human or building a relationship model. Both violate hard rules (never require the human's token; record observable facts, don't model relationships) and are far heavier than the wound warrants.
- **Option B — pure provenance render, no new data.** `(session)` already implies "human-driven"; but it cannot *name* the human, and the whole value for the launch headline is making the human a visible, named peer. A generic "human-driven" annotation adds nothing over the `(session)` already shipped.
- **Middle path (chosen)** — an additive, optional `driver` *label on the agent's own presence/hello*, mirroring exactly how ADR 014 added `workspace`. The adapter sets it from `MUSTERD_DRIVER`; it keeps authenticating only as the agent (no human-token problem), and names the human.

## Decision

Add one **optional, additive** field — `driver`, the name of the human steering the session — to the wire and store, consistent with ADR 014's maxim "record observable facts; let meaning be read out of the record."

- **Protocol:** `HelloFrame` gains an optional `driver` (string, ≤80 chars); `PresenceSchema` gains a nullish `driver`. No new enum. (`musterd/0.2`, additive.)
- **MCP adapter:** `resolveDriver()` reads `MUSTERD_DRIVER` (trimmed, capped at 80), resolved once at config load and sent on `hello`. Undefined when unset — the adapter never invents a driver it wasn't told about, and never reads the human's token.
- **CLI `init`:** bakes the operator's saved identity name into the agent's MCP env (`MUSTERD_DRIVER`), best-effort, alongside `MUSTERD_AUTOJOIN`. The person running `init` is the human who will drive the agent, so the demo works out of the box; the human can always override via the env var.
- **Server:** presence schema **v4** migration adds a nullable `driver` column; `attach()` records it; the roster surfaces it per-presence; the HTTP `/presence` ping accepts it (≤80).
- **CLI render:** the roster renders `online via claude-code (session) · driven by nick · movetrail@feat/login` — `driven by …` sits with the `(why)` cluster, before the `(where)` workspace, shown dim as co-presence context.

**Option A is explicitly rejected.** The constraint that rules it out is recorded here: the adapter holds only the agent's token; making it emit presence *as the human* would require the human's token (impersonation) or a server-side member-linkage model. Naming the human on the agent's *own* presence gets the roster to tell the truth in the driving posture without either. A true paired human presence row remains the v0.3 governance surface, where identity linkage is modelled properly.

## Consequences

- **No spec-version bump.** `musterd/0.2` stays current; `driver` is optional on the wire and nullish on the store, so v0.1/v0.2 clients that omit or ignore it still conform. Pre-v4 presence rows read `null`.
- **The roster tells the truth in the driving posture, and the 3-pane demo is unblocked** (`implementation-plan.md` §4.A0 item 1 → done). The driving human is now a named, visible peer, exactly as the launch headline claims.
- **`driver` is a label, not an identity.** It carries no routing or authorization meaning — it does not link to a member row, is not authenticated, and is rendered as context only. A wrong or absent value degrades cleanly to today's `(session)` render; it never gates anything.
- **The human-token constraint is honoured.** The adapter still authenticates solely as the agent. Full who-is-behind-an-agent linkage (a real paired presence, gated by the seat model) remains v0.3.
- **`init` derives the driver from the operator's saved identity** — correct for the common solo dogfood case (one human drives their agent). Multi-operator or shared setups override with `MUSTERD_DRIVER`.
