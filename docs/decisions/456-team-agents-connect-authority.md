# 456 — Team agents: who may connect a sponsored agent

- Status: proposed — 2026-09-26
- Date: 2026-09-26
- Lane: `01M3FBKNB52C157YTNBY8SD4FT` (goal `demo`)
- Amends: [ADR 449](449-member-expiry-sponsored-agents.md) §4 (the sponsor alone receives and
  re-issues the connect link) and [ADR 452](452-agent-connect-over-oauth.md) §2–3 (an agent's
  OAuth chain is bounded by the agent's standing alone). Sponsorship itself is unchanged.
- Builds on: [ADR 146](146-dogfood-reseat-grant.md) (an opt-in team policy knob, off by
  default) / [ADR 450](450-team-invite-join.md) (teams that admit strangers by invite).

## Context

nick's demo walkthrough (2026-09-26, relayed by sloane `01M3FBM065`): an agent a member creates
should be a **team** agent, not a personal one. Any teammate should be able to start it, direct
it, and hand it work. The sponsor stays the member who answers for it.

Most of that is already true. Messages, handoffs, lanes and asks reach a sponsored agent exactly
as they reach any agent, because ADR 449 gave it an ordinary roster row. One thing is personal. Only
the sponsor can issue the agent's connect link (ADR 449 §4, re-issue route in #1726), and a connect
link is the only way a device starts a sponsored agent over OAuth (ADR 452).

A connect link is also a takeover. Redeeming one revokes every chain the agent holds and evicts
the device that held it (ADR 452 §2.3). So "any member may issue a connect link" means "any member
may take any team agent over". On a team whose members all know each other, that is the point. On
a team that admits strangers by invite (ADR 450), it is a hijack path.

There is a second gap. ADR 452 bounds an agent's chain by the **agent's** standing. The sponsor's
standing counts too, through ADR 449's cascade. The member who connected the device counts for
nothing. Today that member is always the sponsor. Once someone else can connect, removing that
person would leave their device running the agent.

## Problem

1. Let a teammate other than the sponsor start a sponsored agent, where the team wants that.
2. Don't open a takeover path on teams that admit strangers.
3. Keep every running agent session bounded by a person who is still on the team.
4. Make takeovers visible to the people they affect.

## Decision

### 1. Sponsorship stays accountability

`sponsored_by`, the expiry the agent inherits from its sponsor, the per-sponsor cap, and the
revocation cascade are unchanged (ADR 449 §2–3). The sponsor answers for the agent. Sponsorship no
longer decides who may start it.

### 2. Who may issue a connect link is a team policy knob

`PolicySchema` gains `agent_connect: 'sponsor' | 'any_member'`, default `'sponsor'`. An admin sets
it through `POST /teams/:slug/policy`, audited as `policy.change`, as with every other knob.

- `'sponsor'`, the default: the agent's sponsor or a team admin may issue its connect link. This is
  today's behaviour plus admins.
- `'any_member'`: any human member in good standing may issue a connect link for any live sponsored
  agent on the team. Agents never issue connect links.

The default is the safe one on purpose, as with ADR 146's opt-in. A team that admits strangers by
invite should leave it. A team whose members trust one another, like `revive`, turns it on. The
server does not derive the setting from invite usage. A team that once used an invite would flip
behaviour silently, the moment it minted one. That is a change nobody chose, and nothing
prompts anyone to look for it.

### 3. The member who connected a device bounds the session

The connect nonce already records who issued it (`agent_connect_nonces.sponsor_id`, which this ADR
renames `issued_by`). Redemption carries the issuer onto the authorization code and onto the chain
it mints (`connected_by`). The chain is valid only while **both** the agent and its `connected_by`
member are in good standing. The check is `memberStandingRefusal` applied to both rows. It runs at
use in `verifyAccess` and on both token grants (ADR 452 §4's check, extended to a second member).
So removing, disabling or expiring the person who connected an agent stops that device at its next
call. No cascade has to find it. ADR 452 §3's table gains a row: "invalid when the member who
connected it loses their standing".

### 4. Takeovers are visible

- Every issued link is audited as `member.agent_connect_issued`. The actor is the issuer and the
  target is the agent (the row exists since #1726; `actor` becomes the issuer rather than the
  sponsor).
- When a connect supersedes a live chain (ADR 452 §2.3), the daemon sends a directed `message` from
  the new connector to the sponsor and to the previous connector, when those are different people:
  "`<connector>` connected `<agent>` from `<client_name>`; your device's session ended". A takeover
  is never silent to the person it displaces.

### 5. Surfaces

- `POST /teams/:slug/members/agents/:name/connect` authorizes the caller against §2 instead of
  requiring the sponsor.
- The remote `/mcp` endpoint gains `team_agent_connect {name}`, which returns the same one-time link.
  It is the phone-side way for a teammate to start a team agent. `team_agent_create` is unchanged.
- Only sponsored agents are OAuth-connectable (ADR 452). Agents seated through the claim handshake
  keep it unchanged.

## What this does not decide

- Starting a team agent on a host without a person pasting anything. That is lane `01M3FBKS39`, the
  demo stopgap, which builds on this ADR.
- The per-member "may create agents" switch and cap tuning (ADR 449 increment 3, lane
  `01M3FAPB32`).
- Who may **create** agents. That stays with human members, capped per sponsor (ADR 449 §3).

## Considered and rejected

- **`'any_member'` as the default.** It is what nick described for his own team. But it turns every
  invite-admitting team into a takeover surface on day one. The safe default costs a trusted team
  one `policy set`.
- **Admin-only as the restrictive setting.** It excludes the sponsor, who is accountable for the
  agent anyway and could simply create another one. It adds no protection over `'sponsor'`.
- **Deriving the setting from whether the team uses invites.** This is rejected in §2 as hidden,
  flip-on-use state.
- **Cascading revocation from the connector instead of checking at use.** A cascade has to find
  every chain on every removal path (remove, disable, expiry, credential rotation). A check at use
  is exact on all of them, and it is the pattern ADR 449 §1 already chose for expiry.

## Consequences

- `@musterd/protocol`: `PolicySchema.agent_connect` and the remote tool's input. Both are
  ADR-gated wire additions, and this ADR is the gate.
- `@musterd/server`: a migration renames `agent_connect_nonces.sponsor_id` to `issued_by` and adds
  `connected_by` to `oauth_codes` and `oauth_tokens`. The connect route's authorization and
  `verifyAccess` and both token grants gain the connector's standing check. It adds the supersede
  notice and `team_agent_connect`.
- ADR 449 and ADR 452 each get a dated note pointing here once this is accepted. Neither Decision
  is edited.
- `@musterd/cli`: `musterd team policy --agent-connect <sponsor|any_member>`, shown in the policy
  readout beside the other knobs. A team that wants team agents runs it once.

## Observability & Evaluation

- **Traces:** `member.agent_connect_issued` (issuer → agent), `member.agent_connected` (connector →
  agent, client), `oauth.revoked` with `reason: 'superseded'`, `policy.change` for the knob, and
  the supersede notices as ordinary directed messages.
- **Eval:** tests at the HTTP layer.
  - Under `'sponsor'`, a non-sponsor non-admin is refused a link. The sponsor and an admin get one.
  - Under `'any_member'`, a teammate gets a link and connects, and the sponsor and the previous
    connector each receive the supersede notice.
  - Removing the member who connected a device refuses that device's next tool call and next
    refresh, even though the agent and its sponsor are fine.
  - An agent member is refused a link under either setting.
- **Experiment:** in the demo rehearsal, count connects by a non-sponsor, and supersedes where the
  previous connector was someone else. A supersede that surprised its victim, reported by the
  victim, is the signal that §4's notice is not enough.
