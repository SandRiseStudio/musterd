# 337 — Agent HTTP session authority

- Status: accepted — 2026-08-31
- Date: 2026-08-31
- Lane: `01M1CRP2A76T7Q7C6D6H2S79XX`

## Context

The shared Team agent key (`mskey_`) authenticates a harness but is not a Member
identity. The HTTP boundary nevertheless accepts a caller-selected
`x-musterd-seat` alongside that shared key. Any key holder can therefore choose
another active agent Member for HTTP reads or writes. Claim-time grants do not
prove who is making a later HTTP request, and ambient Presence is an effect of
authentication, not evidence of it.

Human credentials and service tokens are self-identifying. Agent HTTP authority
must have the same property while retaining an explicit, admin-authorized
bootstrap claim.

## Problem

Define durable agent authority and live occupancy proof for every agent HTTP
request without making a shared Team secret an impersonation credential.

## Decision

1. The Team agent key is bootstrap-only. It authenticates an unoccupied harness
   solely for the authorized claim handshake. It cannot authenticate a routine
   Member HTTP endpoint and `x-musterd-seat` never supplies authority.
2. Each agent Member receives a rotatable, revocable, server-hashed
   agent-seat credential only after a successful authorized claim. It identifies
   that one Member and is stored only in the bound Workspace configuration.
3. Every agent HTTP request presents the agent-seat credential plus a short-lived
   session lease minted by the successful claim and bound to that Presence. The
   server verifies both before any route, including reads. A lease is invalidated
   on supersession, release, ban, archive, credential rotation, and expiry.
   _(Amended 2026-09-26: an agent seat that entered through ADR 452's sponsor nonce holds an OAuth
   chain instead of a lease. See the note in Consequences.)_
4. Reconnection uses the seat credential to make a fresh claim and receive a
   fresh lease. An ambient touch never renews or substitutes for a lease.
5. WebSocket authority remains connection-bound after its claim. Its occupied
   frame returns the agent credential only when it is newly minted/rotated and
   always returns the current lease; plaintext values are never audited or
   logged.

## Consequences

- HTTP clients must claim or renew before every expired lease and retain two
  secret values in their chmod-600 binding.
- The shared key's blast radius is limited to an authorized initial claim; a
  compromised agent-seat credential is limited to one Member and a lease to one
  live Presence.
- The protocol, server, CLI, MCP, specification, and security design change
  together. Existing `mskey_` HTTP callers are intentionally refused after the
  migration.

- 2026-09-26 — [ADR 452](452-agent-connect-over-oauth.md) amends Decision 3 for agent seats that
  enter over OAuth through a sponsor's one-time connect nonce (ADR 449). Their authority is the
  `msat_`/`msrt_` chain, not a seat credential plus a lease. ADR 452 §3 maps each lease guarantee to
  the chain's: short-lived, invalid on supersession (a new connect revokes prior chains and burns
  unexchanged codes), on ban, archive or disable, on sponsor removal, on credential rotation, and on
  expiry. Every other agent keeps this Decision unchanged.

## Observability & Evaluation

- Audit credential mint/rotation/revocation and lease mint/revocation by IDs,
  never plaintext.
- Regression tests prove a Team key cannot select another agent; a valid seat
  credential without a valid lease cannot read or write; supersession and
  account changes invalidate the lease.
- Eval: the server transport suite is the dataset; its pre-change baseline
  accepts shared-key, caller-selected HTTP identity, while the post-change
  suite requires a claimed credential and matching lease for each agent path.
- Experiment: n/a — this is a boundary hardening change; staged tests and
  audits are the appropriate evidence.
