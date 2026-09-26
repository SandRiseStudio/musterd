# 452 — Sponsor-authorized agent seats over OAuth

- Status: accepted — 2026-09-26, by nick in session (after big-body's security accept
  `01M3E6FS59` and fifty's §5 sign-off `01M3E63MVH`)
- Date: 2026-09-26
- Lane: `01M3AMYC18DQ5ZXK4T570D60Q9` (goal `demo`) — ADR 449 increment 2b
- Amends: [ADR 446](446-remote-mcp-https-oauth.md) §2 (tokens bound to a human seat) and §6 ("agent
  seats over OAuth: refused in v1"), for exactly one path: a sponsored agent redeeming its
  sponsor's connect nonce. [ADR 337](337-agent-http-session-authority.md) §3 (agent HTTP authority
  = seat credential + Presence lease), for agent seats that hold an OAuth chain instead of a claim.
  Every other agent keeps ADR 337 unchanged.
- Builds on: [ADR 449](449-member-expiry-sponsored-agents.md) §3–4 (member-created agents, the
  connect nonce — landed in #1726, #1727 and #1730) / ADR 450 (PR #1717, not yet merged — the shared
  join page and the `proof` union's `invite` arm; this ADR's arm sits beside it) /
  [ADR 170](170-signin-handoff-relay.md) (a nonce may ride a URL, a secret may not) / SPEC A.2
  (hashes only).
- Review gate: ghost (the OAuth seam — conditions in `01M3DJTDDW`, all met below) and big-body
  (security) before merge.

## Context

ADR 449 lets a human member create an agent they sponsor. `team_agent_create` makes the agent's
roster row and returns a one-time connect link, `/join/:team#n=<nonce>`, and no secret. The nonce
is stored hashed, is single-use, lives 15 minutes, and has one live copy per agent. Nothing redeems
it yet.

The agent runs on some device the sponsor controls: Claude Code, Codex or Cursor on a laptop. That
harness reaches the team the way a phone does, by adding the team's `/mcp/:team` connector. The
harness then does OAuth discovery, dynamic registration, and authorization code with PKCE, and
opens a browser at the authorize page. MCP clients implement that grant and no other, so an agent
seat reaching a team from a stranger's device has to come through ADR 446's authorize page.

ADR 446 refuses that. Its §2 binds every `msat_`/`msrt_` chain to a **human** seat and its §6 says
agent seats stay on the claim handshake. ADR 337 §3 makes every agent HTTP request present an
agent-seat credential plus a Presence-bound session lease. The claim handshake needs the Team
agent key, which is bootstrap-only authority for the whole team and is never given to a member's
device.

## Problem

1. A sponsored agent has no way in from its own device. The nonce exists, but no endpoint takes it.
2. Whatever takes it must not create a second way to hold an agent seat that bypasses ADR 337's
   guarantees: bounded lifetime, invalidation on supersession and revocation, and one occupant.
3. The nonce must reach the authorize page when that page opens in whatever browser the harness
   chooses, which is not necessarily where the link was opened (ADR 450, Context).
4. It must not widen OAuth for agents generally. An unsponsored agent, or an agent credential
   typed into the consent page, stays refused.

## Decision

### 1. The `proof` union gains `kind: 'agent_connect'`

`OAuthAuthorizeConfirmSchema.proof` gains a third arm, after ADR 450's `invite`:

```ts
z.object({
  kind: z.literal('agent_connect'),
  nonce: z.string().min(43).max(2048), // the bare nonce, `n=<nonce>`, or the whole connect link
}).strict()
```

The server normalizes the value: it takes the `n` parameter of a pasted link's fragment, or of a
pasted `n=` string, or the bare value. It then requires exactly 43 base64url characters
(`randomBytes(32)`). The arm carries a **nonce only**. No agent credential (`msac_`), lease, or
key is ever a proof, which is ghost's condition. The `credential` arm keeps requiring an `mscr_`.

### 2. Redemption binds the code to the agent

On `POST /oauth/:team/authorize` with an `agent_connect` proof, in one SQLite transaction:

1. `redeemAgentConnectNonce(team, nonce)` from ADR 449. It burns the nonce and returns the agent
   only if the nonce is known, unused, unexpired, and on this team, and the agent is live,
   agent-kind and not disabled. A wrong-team attempt does not burn it.
2. **Refused:** append `member.agent_connect_refused` (detail: client id and the reason class,
   never the nonce) and return one `unauthorized`: "that connect link isn't valid — ask your
   sponsor for a new one". Unknown, used, expired, wrong-team and departed-agent all return this
   same body. No failure budget is kept. The nonce is 256 bits, lives 15 minutes, and is single-use,
   so guessing is not a threat model. ADR 446 §5's per-IP authorize bucket still applies.
3. **Supersede:** revoke every live OAuth chain for that agent (`revokeAllForMember`), **and**
   burn every authorization code bound to it that has not yet been exchanged (`used_at` set, so
   `redeemCode` refuses it as replayed). Audit `oauth.revoked` with `reason: 'superseded'` and the
   counts of chains and codes. An agent seat has at most one OAuth occupant, and connecting a new
   device evicts the old one. This is the chain's equivalent of ADR 337's single-active claim.
   Both kinds of authority must go. An earlier connect's code stays exchangeable for up to 90
   seconds, and §4's member check would still pass it, because the agent is live. Without the
   burn it could mint a second chain after this connect (big-body `01M3DM1CQ2`). The burn, the
   revocation, and step 4's new code share one SQLite transaction. The token endpoint's redemption
   is its own transaction, so SQLite serializes the two. An old code exchanged first yields a chain
   this step revokes. An old code exchanged after is refused.
4. Issue the authorization code exactly as the other proofs do, bound to the **agent** member, and
   append `member.agent_connected` (actor = the sponsor, target = the agent, detail =
   `{client_id, client_name}`). The token flow from here is ADR 446's, unchanged.

### 3. An agent's OAuth chain carries ADR 337's guarantees

ADR 337 §3 binds agent authority to a Presence lease so that authority is short-lived, dies when
superseded or revoked, and has one holder. For an agent seat that entered by §2, the token chain
carries each guarantee:

| ADR 337 lease property | The OAuth chain's equivalent |
| --- | --- |
| short-lived | `msat_` 1h. Refresh rotates single-use, and reuse revokes the chain (ADR 446 §5). |
| invalid on supersession | §2.3: a new connect revokes every prior chain and burns every unexchanged code. |
| invalid on ban/archive/disable | `authMember` refuses the status on every use. The token endpoint refuses it too (§4). |
| invalid on sponsor removal | ADR 449 §2's cascade disables the agent **and** revokes its chains. |
| invalid on credential rotation | The admin rotate path already revokes all chains (ADR 446 §3). |
| invalid on expiry | `authMember` refuses past `lifecycle_until`. Chains are capped at it (§4). |

`verifyAccess` admits an `agent`-kind row as well as `human`. By construction, only §2 can bind a
chain to an agent. Every other agent keeps ADR 337's credential-plus-lease rule untouched, and the
claim handshake is unchanged.

### 4. The token endpoint checks the member, and chains stop at expiry

This half is ADR 449 §1, which already decided it: "`msat_`/`msrt_` TTLs are
`min(kind TTL, lifecycle_until − now)`; a refresh past expiry is refused and revokes the chain".
This ADR lands it for every member, human or agent. It is not specific to agents. On both grants,
the token endpoint refuses (`invalid_grant`) a member who has left, is disabled, banned or
archived, or has expired, and a refusal on the refresh grant also revokes the chain. `expires_in`
reports the capped value. `authMember` stays the enforcement point, so the cap keeps a client's
view of its lifetime truthful but is not what enforces expiry.

### 5. How the nonce reaches the authorize page: paste, never carried in a URL a server sees

The consent page (GET) gains a third form beside ADR 450's two: "Connecting an agent? Paste its
connect link." When the connect link is opened on the agent's device, the join page shows the team's
`/mcp/:team` URL to add in the harness, plus the link's code to copy for sign-in. The page sends the
nonce nowhere. The nonce reaches the server only in the authorize POST body. It never appears in a
query string, the MCP connector URL, a harness config file, a server log, or an edge log. The
consent form's nonce field is `autocomplete="off"` and posts with `method="post"`, so a browser
neither saves it nor puts it in the URL (fifty, `01M3E63MVH`, the same rule as ADR 450's `#i=`).

The join page may pre-fill the consent form when both are served from the daemon's origin. Nothing
depends on that pre-fill, because the authorize page can open in a browser that never saw the link
(ADR 450, Context).

### 6. What an OAuth agent is on the team

It is an ordinary agent member reached as a remote-bearer seat (ADR 446 §4). There is no socket
and no lease, presence comes from authenticated activity, directed acts queue in its inbox, and
it is reached by its own polling. It has no push wake. Its tool set is the remote `/mcp` set,
`team_agent_create` included, which refuses agents because only humans sponsor. No model is
attested over this path. The roster shows the harness by its registered `client_name`, and the
model stays unknown until a later ADR gives remote agents an attestation seam (ADR 056's data
stays clean).

## What this does not decide

- Widening the remote tool set (lanes, goals, memory) for OAuth agents. That is a follow-up once a
  remote agent has been observed using the Done-line set.
- The join page's layout and strings (sloane, miley). It needs the facts in §5: the `#n=` branch
  shows the MCP URL and the code to paste, and sends the nonce nowhere.
- Model attestation for remote agents (§6).
- Per-member switches and per-team caps on agent creation (ADR 449 increment 3).

## Considered and rejected

- **Return an `msac_` agent credential in `team_agent_create`'s result, or in the link.** That puts a
  long-lived secret in a chat transcript or a URL (ADR 170), and it would still need a lease, which
  only a claim mints. ghost's condition rules it out.
- **The claim handshake from the member's device.** It needs the Team agent key, which is
  bootstrap-only authority over the whole team (ADR 337 §1). A stranger's device must never hold it.
- **Put the nonce in the connector URL** (`/mcp/:team?n=…`) so the harness carries it by itself.
  The nonce would sit in a URL the server receives and could log, and in the harness's config file
  indefinitely. Paste costs one copy, and nothing persists.
- **RFC 8628 device authorization** (the agent shows a code and the sponsor approves on their phone).
  This is the cleanest fit on paper, but MCP clients implement authorization code with PKCE only.
  Follows-up: deferred — if MCP clients adopt RFC 8628 (2026-09-26).
- **A failure budget on nonces** like ADR 450 §3. The invite code is 40 bits and needs one. A
  256-bit, 15-minute, single-use nonce does not.

## Consequences

- `@musterd/protocol`: `OAuthAuthorizeConfirmSchema.proof` gains the `agent_connect` arm. This is
  an ADR-gated wire change, and this ADR is the gate. There is no new credential prefix and no new
  table (`agent_connect_nonces` landed in ADR 449's v74).
- `@musterd/server`: the authorize arm and supersession (§2), `verifyAccess` admitting agent rows
  (§3), revoking chains in the cascade (§3), the token endpoint's member check and TTL cap (§4), the
  consent page's third form (§5), and two audit verbs (`member.agent_connected`,
  `member.agent_connect_refused`).
- Sequenced after ADR 450's PR (#1717), because both add an arm to one discriminated union and a
  form to one page. The arms are independent, and neither edits the other's.
- ADR 446 and ADR 337 each get a dated note in `## Consequences` pointing here once this is
  accepted. Neither Decision is edited.
- Follows-up: deferred — a wider remote tool set for OAuth agents, once one has been observed on the
  Done-line set (2026-09-26).
- Follows-up: deferred — model attestation for remote agents, when a remote harness can state its
  model (2026-09-26).
- Follows-up: deferred — same-origin pre-fill of the consent form, if rehearsal's paste failure rate
  exceeds 1 in 5 (2026-09-26).

2026-09-26 — the code landed after ADR 450 increment 2 (#1735), with the Decision unchanged. Three
details not in it: `member.agent_connect_refused` records a reason class (`malformed`: no nonce
could be read; `invalid`: unknown, used, expired, wrong-team, or a departed agent); the supersede's
`oauth.revoked` row is written only when a chain or code was actually revoked; and the member check
on both token grants is `memberStandingRefusal`, the same function `authMember` now calls, so the
two cannot drift.

2026-09-26 — §1's credential refusal now covers the whole pasted value, not only its start
(big-body `01M3FAF83Z`). As first landed, `isMusterdCredential` was a prefix test, and the server
reads the nonce from after `#`. A link carrying a credential in its query (`?t=mscr_…#n=<nonce>`)
therefore passed the schema. `containsMusterdCredential` refuses any prefix where a token can
start: the value's start, or after any non-base64url character. So it never fires inside a nonce,
and nonce minting redraws the ~1-in-10⁷ nonce that would begin with a prefix. Refusal happens at
the schema, before redemption, so the real nonce survives a bad paste.

## Observability & Evaluation

- **Traces:** audit rows `member.agent_connected` (sponsor → agent, client),
  `member.agent_connect_refused` (reason class), and `oauth.revoked` with `reason: 'superseded'`.
  The nonce never appears in any row or log line.
- **Eval (Done line):** on a daemon behind the tunnel, a human signed in on a phone
  calls `team_agent_create`, opens the link on a laptop, adds the connector in Claude Code, pastes
  the code at sign-in, and the agent sends a message the phone sees. Falsifiers, each a test:
  - a second redeem of the same nonce is refused;
  - a reconnect with a re-issued nonce revokes the first chain;
  - a code issued by the first connect and exchanged **after** the second connect is refused;
  - removing the sponsor refuses the agent's next tool call **and** its next refresh;
  - an expiring sponsor's agent receives `expires_in` no later than the sponsor's end;
  - an `msac_` or `mscr_` in the `agent_connect` arm is refused at the schema.
- **Experiment:** in rehearsal, count connect attempts against successful connects. A paste failure
  rate above 1 in 5 is the trigger to build the same-origin pre-fill (§5) before the demo.
