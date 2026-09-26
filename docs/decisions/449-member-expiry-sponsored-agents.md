# 449 — Member expiry is a regular setting, and members can create agents

- Status: accepted — 2026-09-25, by nick in session (reshaped the same day before acceptance:
  nick's steers 01M3D5R783 and 01M3D66PSZ removed the event concept; the original event-scoped
  draft never landed anywhere but this branch)
- Date: 2026-09-25
- Lane: `01M3AMYC18DQ5ZXK4T570D60Q9` (goal `demo`)
- Builds on: [ADR 446](446-remote-mcp-https-oauth.md) (remote MCP over HTTPS + OAuth — the rail a
  phone or laptop joins over; PR #1694) / [ADR 337](337-agent-http-credential-lease.md) (agent
  HTTP authority) / [ADR 134](134-provisioning-is-privileged.md) (minting a member is privileged)
  / [ADR 170](170-signin-handoff-relay.md) (a nonce may ride a URL, a secret may not) / SPEC A.2
  (hashes only) / A.7 (prefix dispatch). ADR 450 (fifty) consumes §1's expiry at invite-admit.
- Review gate: big-body reviews security before merge — members minting identities exceeds the
  scope of the 2026-09-24 demo-plan review (`01M3AMV2VK`).

## Context

nick's requirement (2026-09-25, acts `01M3D5R783` + `01M3D66PSZ`): the demo uses **only regular
musterd**. No "event members", no team-level event clock, no temporary machinery that exists for
one day. Humans join a team over the ADR 446 OAuth rail from whatever client they hold (ChatGPT,
Claude app, Cursor, Codex); joined humans can create agents on the team. What the demo needs from
the platform is therefore two *ordinary* features:

1. **Member expiry as a per-member setting.** A member may carry an end date — set when they are
   added (fifty's invite path, ADR 450) or later — and it is enforced, on any team. The demo team
   simply adds its members with an expiry; `revive` adds members without one.
2. **Member-created agents.** A human member can create agents the way nick does today — on the
   team side, `musterd agent`'s semantics: a real agent-kind member with its own name, role and
   credential. The workspace half stays on whatever device runs the agent; its harness reaches
   the team over the same `/mcp` endpoint (the sign-in seam is an ADR 446 follow-up, §4).

## Problem

1. **Expiry is stored but not enforced.** `members.lifecycle_until` (`lifecycle: 'until'`) has
   existed since v1 and no auth path reads it: an expired member still authenticates. The
   data-model doc said so out loud ("store, don't enforce").
2. **Nothing cascades a revocation.** Disabling one member leaves the agents they created live —
   authority outliving the authorizer.
3. **Minting is admin-or-local-peer only (ADR 134).** A regular member has no sanctioned way to
   create an agent, and the agent they'd create has no way to sign in from a remote device
   (ADR 446 §6 refuses agent seats over OAuth).

## Decision

Four parts. Nothing here is event-scoped; every rule applies to every team.

### 1. Expiry is enforced at auth, from the member's lifecycle

`authMember` gains the check the column has been waiting for: a member with
`lifecycle: 'until'` and `lifecycle_until < now` is refused (`forbidden`, "membership expired")
on **every** credential kind — `mscr_`, `msac_`, OAuth `msat_`, service token. No event guard:
any seat that declares an end now has one. (No member on any team on this machine carried
`lifecycle: 'until'` when this shipped — verified against the daemon DB — so nothing changes out
from under anyone.)

Setting it is ordinary member administration: at add (`AddMemberInput.lifecycle/lifecycleUntil`,
already wired) or later via the existing identity-update path. OAuth chains are capped by the
same clock at mint: `msat_`/`msrt_` TTLs are `min(kind TTL, lifecycle_until − now)`; a refresh
past expiry is refused and revokes the chain. A sweep marking expired members `left_at` is
cosmetic roster hygiene (increment 3), never load-bearing.

### 2. Sponsorship: `members.sponsored_by`, revocation cascades

Migration v73 adds `members.sponsored_by` (nullable member id). A member minted by another
member carries the minting member's id; admin/local-peer mints stay `NULL`. Rules:

- **Revoke cascades down.** Removing or disabling a member also disables every live member whose
  `sponsored_by` chain reaches them, transitively — one `member.revoked_cascade` audit row per
  affected member, naming the root.
- **Expiry cascades by construction, not by sweep:** a sponsored member's `lifecycle_until` is
  capped at its sponsor's at mint (§3), so it can never outlive them.

### 3. `team_agent_create`: a human member mints an agent, capped

A new MCP tool + HTTP route (`POST /teams/:slug/members/agents`), callable by any **human**
member. Semantics:

- Creates an agent-kind member via the existing `addMember` path — the same store code
  `musterd agent` reaches — with `sponsored_by` = the caller, `lifecycle_until` capped at the
  caller's own (an unexpiring caller mints unexpiring agents), and the caller's chosen
  `name`/`role` (validated and collision-refused like any mint).
- **Cap:** at most `SPONSORED_AGENT_CAP = 3` live agents per sponsor (server-enforced, admin-tunable
  per team; the refusal names the cap). Rate limit rides the ADR 446 §5 per-IP buckets.
- ADR 134 stands: this is a deliberate, narrow, audited grant to human members, not a loosening —
  and an admin can disable it per member through capabilities.
- Audit: `member.sponsored_agent_created` (sponsor, agent, when).

### 4. The agent's way in: a sponsor-authorized connect handoff

`team_agent_create`'s response carries no secret. It returns the agent's name and a **one-time
connect URL** (`/join/:team/agent#<nonce>` — a nonce may ride a URL, ADR 170): the sponsor opens
it on (or sends it to) the device that will run the agent. That device's harness adds the same
`/mcp/:team` connector; at the OAuth authorize step the nonce redeems as the authorization —
consent was given by the sponsor at create time — and the token endpoint mints an `msat_`/`msrt_`
chain **bound to the agent seat**. This is a sponsor-authorized exception to ADR 446 §6's refusal
of agent seats over OAuth; per ghost (`01M3D4QZ4F`) it lands as a follow-up amendment to ADR 446
after PR #1694 merges, not inside it. Nonce: single-use, 15-minute TTL, `randomBytes(32)`,
stored hashed, burned on redeem or expiry.

Model attestation for member surfaces and sponsored agents records `unknown` or the client's own
name — never a guess (keeps ADR 056 data clean).

## What this does not decide

- The invite that admits a **new human** member at OAuth sign-in — ADR 450 (fifty, PR #1717),
  which sets that member's expiry through §1's ordinary fields.
- Whether sponsored agents gain Workspaces, wakes, or lane-acceptance eligibility — they are
  ordinary agent members; current routing treats them as such.
- Demo-team teardown (stop tunnel, archive team) — big-body's runbook (ADR 448).
- The ADR 446 amendment's exact wire shape for the agent authorize proof — written with that
  amendment (ghost or stanley, whoever takes the seam).

## Considered and rejected

- **An event concept** (`teams.event_ends_at`, event-only gates — this ADR's own first draft,
  same branch). nick: "no temporary stuff just for events." Regular per-member expiry serves the
  demo and every other team; the event framing served only the demo.
- **Token-in-URL joining** (the 2026-09-24 plan). Dead: every target client speaks OAuth
  (big-body accept `01M3D4DAN`), and the secret-in-URL leak surface bought nothing after ADR 446.
- **Puppet agents** (sub-identities riding the human's credential). Breaks "the same way nick
  creates agents": no own credential, no honest roster row, attribution mush.
- **A separate guest/temporary credential kind.** Nothing it would express that
  `lifecycle_until` + `sponsored_by` + the existing kinds do not.
- **Sweeper-enforced expiry.** Enforcement at auth is exact and race-free; a sweeper is cosmetic
  and follows later.

## Consequences

- `@musterd/protocol`: `MemberSchema` gains `sponsored_by` (nullable) — ADR-gated wire change,
  this ADR is the gate. No new credential prefixes, no team schema change.
- `@musterd/server`: migration v73 (one column), the `authMember` expiry check, the cascade on
  the remove path, then (increment 2) the create route + nonce store and two audit verbs.
- `lifecycle_until` flips from documented-unenforced to enforced; `01-data-model.md` updated in
  the same commit. Clock skew tolerance ±30s, same as ADR 446's codes.
- Increments: (1) migration + expiry enforcement + cascade + tests (this branch); (2)
  `team_agent_create` + nonce handoff + tests (needs ADR 446 merged; dolly offered — handoff
  recorded on the lane); (3) sweeper + cap tuning + OAuth-TTL capping at the token endpoint.

## Observability & Evaluation

- Traces: audit verbs `member.sponsored_agent_created` and `member.revoked_cascade` — who, whom,
  when; never a credential. Expiry refusals surface in the existing `http_request` warn lines
  (redacted paths, ADR 082 / #1707).
- Eval: the demo rehearsal falsifier — from an attendee device, join as a human (ADR 450 invite),
  create an agent, wire a second client to it, and watch both refuse after their expiry passes.
  Dataset: the rehearsal matrix (Claude phone + ChatGPT web + one Cursor/Codex laptop). Baseline:
  today's build, where `lifecycle_until` is never enforced and no member can mint an agent.
- Experiment: negative tests ship with each increment — an expired member is refused on every
  credential kind; a member with no expiry is untouched; revoking a sponsor disables their agents
  transitively; a sponsored agent's expiry never exceeds its sponsor's; the 4th live sponsored
  agent is refused; a redeemed or stale nonce is refused. The demo's evidence: `/live` shows a
  human join followed by that human's agent joining as two distinct roster rows.
