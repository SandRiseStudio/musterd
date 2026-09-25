# 450 — Event room code: a stranger's OAuth sign-in admits a new human member

- Status: proposed — 2026-09-25
- Date: 2026-09-25
- Lane: `01M3AKNF0JXY8HFN1P4HTMPWCY` (join link, goal `demo`)
- Builds on: [ADR 446](446-remote-mcp-https-oauth.md) (remote MCP + OAuth; its §3 authorize seam
  and §6 "the join link becomes a second prover at the same seam"; PR #1694) /
  [ADR 449](449-event-membership-sponsored-agents.md) (event clock `teams.event_ends_at`, lifecycle
  enforcement at auth, sponsorship; PR #1713) / [ADR 134](134-provisioning-is-privileged.md)
  (minting a member is privileged) / [ADR 170](170-signin-handoff-relay.md) / SPEC A.2 (hashes
  only).
- Review gate: big-body reviews security before merge (strangers minting identities).

## Context

nick reset the demo on 2026-09-25 (act `01M3D3V58A`): people in a room join a team nick created,
from their own devices, as **human** members, through a remote MCP connector that signs in with
OAuth (ADR 446). ADR 446's authorize step only admits a person who already holds a seat, proven by
that seat's `mscr_` credential. A stranger holds nothing. ADR 446 §6 and ADR 449 "What this does
not decide" both leave the prover that admits a **new** human seat to this lane.

Where the sign-in page opens is not under our control. claude.ai opens it in the browser where the
reader added the connector. ChatGPT opens it in its own web view. Cursor and Codex open the
system browser. The join page (`/join/<team>`, sloane's copy, miley's build) may be served from
musterd.io, which is a different origin from the daemon behind the tunnel. So nothing the join
page sets (a cookie, local storage) reliably reaches the sign-in page.

## Problem

1. The authorize page has no way to admit someone who is not already a member.
2. Whatever admits them must work when the sign-in page opens in a different browser, app, or
   device from the one that opened the join page.
3. It must not make the team an open door. A stranger must show they were given something by the
   team's admin, and that thing must expire and be revocable on its own, separate from the
   members it admits.

## Decision

nick chose the room code on 2026-09-25 over a per-person link (breaks when sign-in opens in a
different browser) and an open door (no gate).

### 1. An event invite is a room code

An admin mints an invite for an **event team** (a team with `event_ends_at` set, ADR 449 §1):

```
musterd team invite create [--uses <n>] [--expires <iso>]   # prints the code once
musterd team invite list                                     # id, uses/max, expiry, state — never the code
musterd team invite revoke <id>
```

- The code is 8 characters of Crockford base32 from `randomBytes` (40 bits), shown as
  `XXXX-XXXX`. Input is case-insensitive, ignores `-` and spaces, and maps `O→0`, `I/L→1`.
- Stored **only as sha256** in a new table `team_invites` (`id`, `team_id`, `code_hash`,
  `max_uses`, `uses`, `expires_at`, `created_by`, `created_at`, `revoked_at`). The plaintext is
  printed once, like every other credential (hard rule 5).
- Defaults: `max_uses` 100, `expires_at` = `event_ends_at`. `expires_at` may never be later than
  `event_ends_at`. Minting is admin-only (ADR 134 unchanged: the admin is the one who provisions,
  the code is their delegated, bounded authority).
- A team may hold several live invites (for example one per talk). Revoking one does not affect
  members it already admitted. Their lifetime comes from the event clock (ADR 449 §2) and they are
  removed by the member revoke path, not the invite.

The code is shown on the join page's room card and the presenter's screen. It carries no identity
and no seat. On its own it grants nothing except the right to create one new member at sign-in.

### 2. The authorize page gains a second proof: `kind: 'invite'`

`OAuthAuthorizeConfirmSchema.proof` (a discriminated union, ADR 446) gains:

```ts
z.object({
  kind: z.literal('invite'),
  code: z.string().min(8).max(16),   // normalized server-side
  name: z.string().min(1).max(64),   // the name the stranger picks; addMember rules apply
}).strict()
```

The consent page (GET) offers both forms on an event team. "I'm new — room code + pick a name" is
the first form, and "I already have a seat — `mscr_`" the second. On a non-event team only the
`mscr_` form renders and a posted `invite` proof is refused.

On `POST /oauth/:team/authorize` with an `invite` proof, in one SQLite transaction:

1. The team must be an event team with `event_ends_at` in the future. Otherwise refuse with
   `forbidden` and "this team is no longer taking new members". That refusal is the team's front
   door closing, and stanley's lane tests against it.
2. Look up the invite by `sha256(normalize(code))` with a constant-time compare. It must be
   unrevoked, unexpired and under `max_uses`. Every failure returns the same `unauthorized`
   ("that room code isn't valid for this team"), so a caller cannot tell a wrong code from a used
   one.
3. The name must not exist on the team **in any state**, including a removed (tombstoned) member.
   `addMember` revives a tombstoned name (ADR 065), and a stranger must never revive someone else's
   seat. Refuse with `conflict` ("that name is taken — pick another").
4. `addMember` with `kind: 'human'`, the team's default non-admin role, `lifecycle: 'until'`,
   `lifecycleUntil: event_ends_at`, `sponsored_by: NULL` (ADR 449 §3: invite-admitted humans are
   root sponsors). The `mscr_` token `addMember` returns is discarded, never shown or logged. The
   member's way back in is OAuth refresh, and an admin can still rotate it.
5. Increment `uses`, append audit `member.invite_admitted` (actor = the new member, target = the
   invite id, detail = `{client_id}`, never the code), then issue the authorization code exactly as
   the `credential` proof does. From here, ADR 446's token flow is unchanged.

### 3. Guessing is uneconomic

40 bits against ADR 446 §5's authorize bucket (10/min per client IP, keyed on `CF-Connecting-IP`
behind the tunnel) is about 10¹¹ attempts per IP at 10 per minute. There is deliberately no
team-wide lockout: one would let a single caller shut the door on the whole room. Failed
invite proofs are audited (`member.invite_refused`, no code) so an admin can see an attempt and
revoke.

### 4. What a joined member can do afterward

Nothing new here. The member is an ordinary human member. ADR 449 governs expiry, revocation, and
agent creation. Signing in a second client (phone and laptop) needs the member's `mscr_`, which
this flow never reveals, so in v1 **one invite admission = one signed-in client**. Tokens from
that client refresh until the event ends. A second client is increment 2 (below).

## What this does not decide

- The join page's layout and strings (sloane `01M3AKNKQ1` / `01M3D422B6`, miley's build). It needs
  exactly one new fact from this ADR: the room code is typed on the sign-in page, so the page
  shows the code and says so.
- Expiry, revocation cascade, sponsored agents — ADR 449.
- A per-person single-use link. Rejected for v1 (below). If it comes back, it is a third `proof`
  kind at the same seam.

## Considered and rejected

- **Per-person link carried by a cookie.** One link per person is a stronger gate, but the cookie
  lives in whichever browser opened the link. Sign-in often opens somewhere else: Codex and Cursor
  use the system browser, and a QR code scanned in Safari does not reach claude.ai in Chrome. When
  it fails, the attendee is stuck in front of the room with no recovery.
- **Open door** (a name plus the event clock, no invite). Anyone who sees the team URL on a slide,
  a recording, or a screenshot joins. The event clock limits how long, not who.
- **Code in the connector URL** (`/mcp/<team>?invite=…`). Puts a secret in connector config and
  edge logs, which is exactly what the token-in-URL reset removed (ADR 446, big-body's
  `01M3D4DANJ`).
- **Showing the new member's `mscr_` after sign-in** so they can add a second client. The authorize
  step ends in a 302 back to the app, so there is no page to show it on. Adding one means a
  secret on a phone screen to be copied by hand, for a case the demo does not need.

## Consequences

- `@musterd/protocol`: the authorize `proof` union gains `invite`. That wire change is gated by
  this ADR. No new credential prefix (the room code is typed by humans, not dispatched by prefix).
- `@musterd/server`: one migration (`team_invites`), the invite store (mint / list / revoke /
  redeem), the second consent form, the `invite` branch in `POST /oauth/:team/authorize`, and two
  audit verbs. Needs ADR 446 (#1694) and ADR 449's `event_ends_at` + lifecycle columns (#1713)
  merged first.
- `musterd` CLI: `team invite create|list|revoke`, admin-only, in the Figma terminal style.
- Increments: (1) this ADR; (2) invite table + store + CLI + authorize branch + tests (on
  ADR 446 and 449 increment 1); (3) second-client sign-in for an invite-admitted member, if
  rehearsal shows attendees want it.

## Observability & Evaluation

- Traces: `member.invite_admitted` and `member.invite_refused` audit rows (who, which invite id,
  which client; never the code). `team invite list` shows uses against `max_uses`.
- Eval: the rehearsal falsifier (lane `01M3AKNPS1`). Dataset: the demo rehearsal matrix. Three phones (one on cellular) plus one
  ChatGPT web and one Codex laptop join a fresh event team by typing the room code. Each becomes a
  distinct human row on `/live`. Baseline: today, none of them can join.
- Experiment: negative tests that ship with increment 2: wrong code, revoked invite, expired invite, and
  exhausted `max_uses` all return the same refusal. A taken name and a tombstoned name are both
  refused. A non-event team refuses an `invite` proof. After `event_ends_at` the door refuses. The
  code never appears in logs, audit, or error bodies. `revive` (no `event_ends_at`) behaves the
  same before and after.
