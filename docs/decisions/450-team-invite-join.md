# 450 — Team invite: a stranger's OAuth sign-in admits a new human member

- Status: accepted — 2026-09-26 (big-body security accept `01M3E6FSN5`); proposed 2026-09-25 (reshaped 2026-09-26: no event concept, per nick's steers
  `01M3D5R783` / `01M3D66PSZ`; guess-resistance reworked after big-body's reviews `01M3DH981F`,
  `01M3DJVZPD` and `01M3DKJ0ET`)
- Date: 2026-09-25
- Lane: `01M3AKNF0JXY8HFN1P4HTMPWCY` (join link, goal `demo`)
- Builds on: [ADR 446](446-remote-mcp-https-oauth.md) (remote MCP + OAuth; its §3 authorize seam
  and §6 "the join link becomes a second prover at the same seam"; PR #1694) /
  [ADR 449](449-member-expiry-sponsored-agents.md) (per-member expiry enforced at auth,
  sponsorship; PR #1713) / [ADR 134](134-provisioning-is-privileged.md) (minting a member is
  privileged) / [ADR 170](170-signin-handoff-relay.md) / SPEC A.2 (hashes only).
- Review gate: big-body reviews security before merge (strangers minting identities).

## Context

nick reset the demo on 2026-09-25 (act `01M3D3V58A`): people in a room join a team nick created,
from their own devices, as **human** members, through a remote MCP connector that signs in with
OAuth (ADR 446). ADR 446's authorize step only admits a person who already holds a seat, proven by
that seat's `mscr_` credential. A stranger holds nothing. ADR 446 §6 and ADR 449 "What this does
not decide" both leave the prover that admits a **new** human seat to this lane.

nick's steer of 2026-09-26 (`01M3D5R783`, refined by `01M3D66PSZ`): there is no such thing as an
"event member" or an event team. Attendees are ordinary human members of an ordinary team. Expiry
is an ordinary per-member setting available on every team (ADR 449 §1, enforced at auth), not an
event concept. So this ADR is about **team invites**, a regular capability of every team, which the
demo happens to use.

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
4. The gate must resist guessing from **many** sources at once, not only from one IP, and a
   guesser must not be able to lock the whole team out (big-body `01M3DH981F`).

## Decision

nick chose a typed room code on 2026-09-25 over a per-person link (breaks when sign-in opens in a
different browser) and an open door (no gate). The reshape keeps the typed code as the human
fallback and adds a long secret in the link as the primary path, with one failure budget per
invite bounding both.

### 1. A team invite is a secret with a budget

An admin of **any** team mints an invite:

```
musterd team invite create [--uses <n>] [--expires <iso|duration>] [--member-until <iso|duration>]
                                                            # prints link + code once
musterd team invite list                                    # id, uses/max, failures/budget, expiry, state — never the secret
musterd team invite revoke <id>
```

One invite has a **non-secret selector** and **two spellings of one secret**, the secret from
`randomBytes(20)`:

- **The selector** — 3 characters of Crockford base32 (`sel`), unique among the team's live
  invites, drawn at mint. It names *which* invite a caller is trying, so a failure is charged to
  that invite alone (§3). It is not secret: it is on the slide next to the code.
- **The link secret** — the full 160 bits, base64url, carried in the join link and its QR
  (`/join/<team>#i=<sel>.<secret>`; the fragment never reaches a server log). This is the primary
  path: the phone opens the link, the join page passes the value through to the sign-in form.
- **The room code** — the first 40 bits of the secret, 8 characters of Crockford base32, shown
  with the selector as `SEL-XXXX-XXXX`, for a person who must type instead of scan. Input is
  case-insensitive, ignores `-` and spaces, and maps `O→0`, `I/L→1`.

Stored in a new table `team_invites` (`id`, `team_id`, `selector`, `secret_hash`, `code_mac`,
`max_uses`, `uses`, `fail_budget`, `failures`, `expires_at`, `member_until`, `created_by`,
`created_at`, `revoked_at`; unique `(team_id, selector)` among unrevoked rows). The plaintext
secret is printed once (hard rule 5). The two verifiers differ on purpose (§3):

- `secret_hash` = `sha256(secret)`. 160 bits of entropy make the plain hash unguessable offline,
  the same posture as every `ms*_` credential (SPEC A.2).
- `code_mac` = `HMAC-SHA256(k_invite, team_id ‖ selector ‖ code)`, where `k_invite` is a 256-bit
  key the daemon generates on first use and keeps **outside the database**: `invite.key` in the
  directory of the effective config file (`MUSTERD_CONFIG` if set, else `~/.musterd/config.json`),
  created and enforced at mode 0600 — the same resolution and posture as `config.json` itself. 40 bits is enumerable offline in
  minutes against a plain hash; keyed, a copy of the database alone verifies nothing.

- `expires_at` is chosen by the minter (default 24h). `max_uses` default 100.
- `fail_budget` default 20. **When `failures` reaches it the invite burns** (§3).
- `member_until`, optional: the ordinary `lifecycle: 'until'` / `lifecycle_until` stamped on every
  member this invite admits (ADR 449 §1). Absent, the admitted member gets the team's default
  lifecycle. This is the only place expiry enters: an invite may set a member's expiry the way an
  admin can, nothing more.
- Minting is admin-only (ADR 134 unchanged: the code is the admin's delegated, bounded authority).
- A team may hold several live invites. Revoking one does not affect members it already admitted;
  they are removed by the member revoke path (ADR 449 §2), not the invite.

The secret carries no identity and no seat. On its own it grants nothing except the right to
create one new human member at sign-in, while the invite is live.

### 2. The authorize page gains a second proof: `kind: 'invite'`

`OAuthAuthorizeConfirmSchema.proof` (a discriminated union, ADR 446) gains:

```ts
z.object({
  kind: z.literal('invite'),
  secret: z.string().min(11).max(64), // `<sel>.<link secret>` or a typed `SEL-XXXX-XXXX`; normalized server-side
  name: z.string().min(1).max(64),    // the name the stranger picks; addMember rules apply
}).strict()
```

The consent page (GET) offers both forms on every team. "I'm new — invite + pick a name" is the
first form; when the request URL carries the link secret the field is pre-filled and hidden, and
the person only picks a name. "I already have a seat — `mscr_`" is the second form.

On `POST /oauth/:team/authorize` with an `invite` proof, in one SQLite transaction:

1. Normalize and split: the first 3 characters are the selector, the rest is the secret. Look up
   the team's **live** invite with that selector (unrevoked, unexpired, `uses < max_uses`,
   `failures < fail_budget`). 27+ remaining characters is a link secret, compared against
   `secret_hash`; 8 remaining characters is a room code, MACed under `k_invite` and compared
   against `code_mac`. Both compares are constant-time.
2. **No match:** if the selector named a live invite, increment **that invite's** `failures` and
   no other's; if it named nothing, charge nothing (there is nothing to protect, and a guesser
   learns only that a 3-character public prefix is unused). Either way append audit
   `member.invite_refused` (client id, selector tried, kind of secret tried, never the secret) and
   return one `unauthorized` ("that invite isn't valid for this team"). Wrong, expired, revoked,
   exhausted, burned and unknown-selector all return this same body.
3. The name must not exist on the team **in any state**, including a removed (tombstoned) member.
   `addMember` revives a tombstoned name (ADR 065), and a stranger must never revive someone else's
   seat. Refuse with `conflict` ("that name is taken — pick another"); this does not count as a
   failure.
4. `addMember` with `kind: 'human'`, the team's default non-admin role, `lifecycle`/`lifecycle_until`
   from `member_until` if set, else the team default, `sponsored_by: NULL` (ADR 449 §2: an
   invite-admitted human is a root sponsor; the admin who minted the invite is recorded on the
   audit row, not as a sponsor, so removing the admin does not cascade to the room). The `mscr_`
   token `addMember` returns is discarded, never shown or logged. The member's way back in is OAuth
   refresh, and an admin can still re-issue it (`team credential`).
5. Increment `uses`, append audit `member.invite_admitted` (actor = the new member, target = the
   invite id, detail = `{client_id, via: 'link'|'code'}`), then issue the authorization code
   exactly as the `credential` proof does. From here, ADR 446's token flow is unchanged.

### 3. Guess resistance is a per-invite budget, not a rate limit

ADR 446 §5's authorize bucket (10/min per `CF-Connecting-IP`) stays, but it is a nuisance control,
not the bound: it limits one source, and a guesser can have many. The bound is the **failure
budget**, which is source-independent:

- Each invite with budget `B` accepts at most `B` wrong secrets before it burns, however many IPs
  send them and however many other invites are live. With the default `B` = 20 the probability
  that any number of guessers hits one invite's 40-bit code before it burns is
  `≤ 20 / 2^40 ≈ 2·10⁻¹¹`, and a team with `k` live invites exposes `≤ k·20 / 2^40` in total.
  This holds across the invite's whole validity window, because the budget does not refill.
- The link secret is 160 bits; the same budget applies, and no realistic budget makes it guessable.
- **Offline, against a copy of the database** (a leaked backup, a read-only SQL foothold, a
  `.sqlite` in a screenshot): `secret_hash` is a plain hash of 160 bits — infeasible. `code_mac`
  is keyed, and the key is not in the database, so the 2^40 code space cannot be enumerated
  from the dump; the attacker is back to the online path and its budget. An attacker who has the
  database **and** `invite.key` has the daemon's home directory, i.e. `config.json` and every
  agent key on the host — the invite is not the asset that matters at that point. Rotating
  `invite.key` invalidates every live room code (links keep working); `team invite list` says so
  and the presenter re-mints.
- **Burning is per invite, so the DoS surface is one invite** — and the selector is what makes
  that true: a failure is charged to the invite the caller named, so twenty typos (or a
  distributed guesser) against `ABC-…` burn `ABC` and leave `DEF`'s link and code untouched. A
  hostile caller who spends the budget closes that invite; the room is not locked out, and the
  presenter re-mints (one command, a new code on the slide). There is deliberately no team-wide
  lockout and no per-name lockout.
- The budget also caps how much a leaked room code is worth once revoked: nothing.
- Failures are visible: `team invite list` shows `failures/budget`, and `member.invite_refused`
  audit rows show a guessing run as it happens.

`B` = 20 is the trade between a fat-fingered room and a guesser; it is a per-invite setting
(`--fail-budget`), never higher than 1000, and the eval below measures the mistype rate in
rehearsal.

### 4. What a joined member can do afterward

Nothing new here. The member is an ordinary human member. ADR 449 governs expiry, revocation, and
agent creation (`team_agent_create`). Signing in a second client (phone and laptop) needs the
member's `mscr_`, which this flow never reveals, so in v1 **one invite admission = one signed-in
client**. Tokens from that client refresh until the member's `lifecycle_until`, if any. A second
client is increment 3 (below).

## What this does not decide

- The join page's layout and strings (sloane `01M3AKNKQ1` / `01M3D422B6`, miley's build). It needs
  two facts from this ADR: the link carries `<sel>.<secret>` in the fragment and the page
  forwards it to the sign-in URL; the room code `SEL-XXXX-XXXX` is the fallback, shown on the
  card, typed on the sign-in page.
- Expiry, revocation cascade, sponsored agents — ADR 449.
- The public route: [ADR 451](451-persistent-public-demo-route.md)'s ingress has no line for
  `/join/<team>`; stanley flagged it (`01M3DGHJFN`), big-body owns it. Increment 2 depends on it.
- A per-person single-use link. Rejected for v1 (below). If it comes back, it is a third `proof`
  kind at the same seam.
- stanley's agent connect (ADR 449 increment 2b): the same `/join/<team>` page dispatches on the
  fragment key — `#i=` is this ADR's invite, `#n=` is an agent nonce — and its proof arm
  `kind: 'agent_connect'` sits beside `invite` in the union. Sequenced after this ADR's PR.

## Considered and rejected

- **Per-person link carried by a cookie.** One link per person is a stronger gate, but the cookie
  lives in whichever browser opened the link. Sign-in often opens somewhere else: Codex and Cursor
  use the system browser, and a QR code scanned in Safari does not reach claude.ai in Chrome. When
  it fails, the attendee is stuck in front of the room with no recovery. (The link secret here is
  a shared invite secret, not a cookie — it survives the browser change because the person carries
  the URL, and the room code covers the case where they do not.)
- **Open door** (a name and nothing else). Anyone who sees the team URL on a slide, a recording, or
  a screenshot joins. Expiry limits how long, not who.
- **Code in the connector URL** (`/mcp/<team>?invite=…`). Puts a secret in connector config and
  edge logs, which is exactly what the token-in-URL reset removed (ADR 446, big-body's
  `01M3D4DANJ`). The join-link fragment is different: fragments are not sent to servers, and the
  page forwards the value in a POST body.
- **Rate limit as the guess bound** (this ADR's first draft). A per-IP bucket bounds one source; a
  distributed guesser is unbounded by it, so the draft's "10¹¹ attempts" claim did not follow
  (big-body `01M3DH981F`). Replaced by §3.
- **Team-wide or per-name lockout after N failures.** Turns any guesser into a denial of service
  against the whole room. The per-invite budget keeps the blast radius to one re-mintable invite.
- **Charging every live invite on a no-match** (this ADR's second draft: match a bare code against
  all live invites, and make them all pay for a miss). Contradicts the one-invite blast radius —
  twenty typos burn every code and every link on the team (big-body `01M3DJVZPD`). The
  three-character selector costs the person one more syllable and restores the bound.
- **A longer typed code** (e.g. 12 characters, 60 bits). Better entropy, worse on a phone keyboard
  in a dark room; the budget makes 40 bits enough online, the keyed MAC makes it enough offline,
  and the link path removes typing altogether.
- **Plain `sha256(code)`** (this ADR's third draft). A database-only attacker enumerates 2^40
  in minutes and holds the admission credential without touching the online budget (big-body
  `01M3DKJ0ET`). Replaced by the keyed MAC above.
- **A memory-hard verifier (scrypt/argon2) instead of the HMAC.** Also defensible, but it only
  slows the enumeration (2^40 × cost) rather than removing it, needs parameters tuned per host,
  and puts CPU work on the authorize path a guesser can drive. The key-outside-the-DB posture is
  what the rest of musterd already relies on for `config.json`; reuse it.
- **Event teams / `teams.event_ends_at`** (this ADR's first draft and ADR 449's). Withdrawn by
  nick's steer: no event concept, expiry is per member.
- **Showing the new member's `mscr_` after sign-in** so they can add a second client. The authorize
  step ends in a 302 back to the app, so there is no page to show it on. Adding one means a
  secret on a phone screen to be copied by hand, for a case the demo does not need.

## Consequences

- `@musterd/protocol`: the authorize `proof` union gains `invite`. That wire change is gated by
  this ADR. No new credential prefix (the secret is typed or pasted by humans, not dispatched by
  prefix).
- `@musterd/server`: one migration (`team_invites`), the invite store (mint / list / revoke /
  redeem-or-charge), `invite.key` generation beside the effective config (0600), the second
  consent form, the `invite` branch in `POST /oauth/:team/authorize`,
  and two audit verbs. Needs ADR 446 (#1694, merged c25a50d4) and ADR 449 (#1713, merged
  2026-09-26) — both landed.
- `musterd` CLI: `team invite create|list|revoke`, admin-only, in the Figma terminal style.
- `packages/web`: `/join/<team>` reads `#i=` and forwards it to the sign-in URL.
- Increments: (1) this ADR; (2) invite table + store + CLI + authorize branch + join-page forward
  + tests; (3) second-client sign-in for an invite-admitted member, if rehearsal shows attendees
  want it.

- **2026-09-26 — increment 2 landed** (PR #1735): the protocol `invite` proof arm, migration v75
  `team_invites`, `store/invites.ts`, the two-form consent page, the authorize branch, admin
  `/teams/:slug/invites`, and `musterd team invite create|list|revoke`, with the store, offline,
  multi-invite and HTTP tests above. `invite.key` resolves beside the effective config
  (`MUSTERD_CONFIG` if set, else `~/.musterd/config.json`) at 0600. Still open from this ADR:
  the `/join/<team>` page and its ingress line on ADR 451.

## Observability & Evaluation

- Traces: `member.invite_admitted` (`via: link|code`) and `member.invite_refused` audit rows (who,
  which invite id, which client; never the secret). `team invite list` shows `uses/max_uses` and
  `failures/fail_budget`.
- Eval: the rehearsal falsifier (lane `01M3AKNPS1`). Dataset: the demo rehearsal matrix. Three
  phones (one on cellular) plus one ChatGPT web and one Codex laptop join a fresh team, at least
  two by typing the room code. Each becomes a distinct human row on `/live`. Measured: the mistype
  count per admission, to check the default budget of 20 against a real room. Baseline: today,
  none of them can join.
- Experiment: negative tests that ship with increment 2: wrong secret, revoked, expired, exhausted
  `max_uses`, burned budget, and an unknown selector all return the same refusal. Twenty wrong
  room codes from twenty different `CF-Connecting-IP`s burn the invite and the twenty-first
  correct code is refused. **Multi-invite:** with two live invites, burning the first leaves the
  second's link and code both usable, and an unknown selector charges neither. **Offline:** a
  test opens the store with a fresh (different) `invite.key` and shows the same typed code is
  refused while the same link secret still admits; `team_invites.code_mac` never equals
  `sha256(code)`. A taken name and a
  tombstoned name are both refused without charging. An invite with `member_until` produces a
  member whose `msat_` refuses after that instant (ADR 449 §1). The secret never appears in logs,
  audit, or error bodies. `revive` behaves the same before and after.
