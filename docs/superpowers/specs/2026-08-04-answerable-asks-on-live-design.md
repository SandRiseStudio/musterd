# Answerable asks on /live — design

- Date: 2026-08-04
- Author: miley (lane `01KZ6Z1M71YT2YYBPRXZRRKSKN`)
- Status: design approved by nick in this session; ADR **220** to be written as increment 1.
- Related: [ADR 149](../../decisions/149-ask-surfaces.md) (the rail), [ADR 147](../../decisions/147-human-ask-stream.md) (the ask stream),
  [ADR 170](../../decisions/170-signin-handoff.md) (the sign-in handoff this generalises),
  [ADR 155](../../decisions/155-human-presence-ladder.md) (the presence this activates),
  [ADR 063](../../decisions/063-read-only-observer-seat.md) (the observer seat),
  [ADR 134](../../decisions/134-provisioning-is-localhost-trust-enforced.md) (`isLocalPeer`),
  [ADR 039](../../decisions/039-cross-network-topology.md) (one team, one daemon).

## Problem

The asks & approvals rail on `/live` shows a human what is waiting on them and gives them no way to
answer it. Reported by nick, 2026-08-04: _"I can read them but I can't actually do anything about
them."_

The rail is not broken. `AsksStrip.tsx:93` gates the answer affordances on
`roster.some((m) => m.name === cfg.as)`, and ADR 149 deliberately specified that the auto-provisioned
observer "is read-only by construction (ADR 063) and sees the strip without buttons." What ADR 149
never designed is the **transition** — how a human watching the office becomes themselves.

The root cause is one level below the rail: **`/live` has no member identity slot at all.** It stores
only `musterd.live.observer.v2.<team>`. `/board` has a member slot
(`musterd.board.member.v1.<team>`) and, since ADR 170, an ergonomic way to fill it. `/live` has
neither, so the only path is an advanced form that is visible _before_ you connect and unreachable
once a cached observer exists. A viewer who has connected once is permanently, silently read-only.

### The baseline, measured

From the live team DB on 2026-08-04:

| Fact                                               | Count                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ask` envelopes raised on the team                 | 55                                                                           |
| `ask` envelopes addressed directly to `nick`       | 20                                                                           |
| `accept` / `decline` / `wait` ever sent by `nick`  | **0**                                                                        |
| `nick`'s entire message history                    | 21 (10 `message`, 5 `status_update`, 3 `steer`, 2 `request_help`, 1 `defer`) |
| `signin.handoff_redeemed` (the `/board` path)      | 1, on 2026-07-28 — the day it shipped, never since                           |
| `signin.handoff_missed` with `reason: off_machine` | 0                                                                            |

**No human answer has ever landed on the ask stream, from any surface.** Some of those 20 were
presumably resolved in conversation with the agent directly — which is precisely the unrecorded
answer the ask stream exists to prevent. This is the pre-registered baseline: not low adoption, zero.

The `/board` datum is the second half of the argument. Sign-in there was exercised once, on release
day, and never again — a surface a human must deliberately navigate to does not get used. `/live` is
the surface nick actually lives in, and it is the one that cannot be signed into.

## Decision

**Identity is per browser + team, not per route, and `/live` learns to be answerable.**

### 1. One shared member identity

Both routes read and write `musterd.member.v1.<team>`, migrating `musterd.board.member.v1.<team>` on
read. Sign in once on this browser and you are yourself on both surfaces. The observer stops being
`/live`'s identity and becomes what it always should have been: the fallback for a viewer with no
seat.

Precedence is fixed and total:

1. an explicit watch link (`?as=…#w=…`) — a URL instruction, and how the team deliberately hands the
   office to someone else;
2. the stored member identity for this team;
3. an auto-provisioned observer.

`/broadcast` reads none of it, so streaming still cannot attach a phantom human presence.

### 2. Presence comes free

Nothing to build. ADR 155 increment 3 already heartbeats an authenticated `/live` tab as `online` and
already decays it through the presence timeout when the human goes quiet — the "feature with an idle
floor" nick chose. It has never fired, because no human has ever been signed in on `/live`. This arc
turns on a shipped feature that has sat dark.

### 3. Two ways in

**In-page, the everyday path.** The rail offers **"Sign in as nick to answer"**, one click. It calls a
new localhost-gated `GET /teams/:slug/local-identity`, which returns the identity the CLI already
holds for this team, or `{available: false}`.

ADR 170's nonce exists to make a CLI→browser _link_ inert. When the browser asks the daemon directly
there is no link to make inert, so no nonce is needed and none is minted. The cost, stated plainly:
the daemon reads the CLI's identity vault (`~/.musterd/config.json`), a file owned by
`packages/cli`. This is contained in one small named module rather than spread through the server.
The trust argument is the one ADR 134 already makes — same machine, same user, `isLocalPeer` plus the
ADR 040 origin gate, and the credential is already plaintext in that file.

**From the terminal, for a cold start.** `musterd live`, a sibling of `musterd board`: `signinUrl()`
grows a surface parameter and the `#s=` redemption moves into shared code both routes call.

### 4. The rail states the state and offers the way in

The way in occupies the slot the answer will occupy, so one click swaps it for Approve/Deny in place
and the rail never moves. ADR 149's constraint holds unchanged: **one line, always, in every state.**

| Condition                                                     | The action slot holds                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Signed in as a member                                         | Approve · Deny · Deciding — 1h                                    |
| Observer, local identity available                            | **Sign in as nick to answer** (accent)                            |
| Observer, no local identity (off-machine, or no CLI identity) | `sign in with a credential →` (ghost, opens the paste form)       |
| Arrived by watch link                                         | nothing — the team handed this viewer a read-only view on purpose |

A **seat chip** sits at the right end in every state: `nick · revive` when signed in, `watching` when
not. With several teams on one machine this is not decoration — it is the answer to "who am I about
to approve as?", and approving as the wrong identity on the wrong team is unrecoverable. The chip is
also the control: clicking it offers "watch as observer instead", which fixes the current dead-end
where a cached observer can never be escaped without clearing localStorage.

## The two constraints nick raised

### Multiple teams on one computer

Free. ADR 039's invariant is one team, one daemon, so separate projects mean separate daemons on
separate ports, and localStorage is already per-origin. The per-team key is belt-and-braces on top,
and `GET /teams/:slug/local-identity` resolves `identities[<slug>]` from a CLI vault that is already
keyed by team.

What multi-team adds is not a mechanism problem but a safety one, and it is why the seat chip is a
requirement rather than a nicety: **the signed-in identity is never implicit.**

### Two human admins on different computers

`requireLocalPeer` gates exactly the two ADR 170 handoff routes, and will gate the new one. So for a
second admin reaching the daemon over an overlay:

- One-click and `musterd live` **correctly refuse**, and must — the local-identity route hands back a
  credential, and off-machine that would hand admin B admin A's identity.
- **The paste path works over the network.** A member credential is an ordinary HTTP bearer, not
  localhost-gated. Admin B can sign in and answer asks today. The requirement is met; the ergonomics
  are not.

Closing that ergonomic gap needs the bounded-credential schema change ADR 170 declined — a migration
plus a new branch in `authMember`, an auth-path change larger than this entire arc. **Deferred to its
own thread by nick's decision.** This arc's job is to make the remote path honest and functional, and
to count the refusals: ADR 170 pre-registered `off_machine` misses as "the cross-device thread
demanding to exist, with a number attached." That counter currently reads zero. This arc is what
starts moving it.

### Two admins answering the same ask

Buttons disable the moment **any** answer for that ask arrives over the firehose, not just your own —
today `busy` is keyed on the local send, so two admins would both see live buttons on an
already-answered ask. First envelope wins; the rail settles and names who answered.

### An expired member credential

The existing 401 self-heal silently reprovisions an observer. For a member that would silently remove
the buttons again, reproducing the exact defect this spec fixes. So a member 401 falls back to an
observer **and says so**: _"your sign-in expired — sign in again."_

## Increments

1. **ADR 221** — the decision, the boundary, the zero baseline. Number confirmed against fresh
   `origin/main` at branch time (219 is taken on izzo's branch; re-confirm at the last moment).
2. **Shared member identity** — `musterd.member.v1.<team>`, both routes prefer it, board key migrated
   on read. Web only, no daemon change. Ships value alone: `musterd board` starts reaching `/live`.
3. **The rail** — the action-slot sign-in, the seat chip in both states, disable-on-any-answer, the
   expired-sign-in notice. Works against the paste path immediately.
4. **`GET /teams/:slug/local-identity`** — localhost-gated, one contained CLI-vault reader module,
   `{available: false}` off-machine, audit rows. Upgrades increment 3's button to one click.
5. **`musterd live`** — `signinUrl()` gains a surface parameter; `#s=` redemption becomes shared code.

Increments 2–5 are independently shippable in this order; each leaves the product better than it
found it, and none depends on a later one.

## Observability & Evaluation

**Traces.** Two audit rows on the existing member-audit channel: `signin.local_offered`
(`{member, surface: 'web-live'}`) when the daemon confirms a local identity to a page, and
`signin.local_redeemed` (`{member, surface: 'web-live'}`) when the page connects with it. The
off-machine refusal reuses ADR 170's `signin.handoff_missed` with `reason: off_machine`, so the
cross-device counter is one series across both mechanisms rather than two half-series. No credential
and no identity vault path is ever logged.

**Evaluation.** The claim is that a human cannot answer asks because the surface they live on will
not let them be themselves. The measure is therefore not adoption but **the first ask ever answered
from a browser**, against a baseline of zero that is provable from the table above: 20 asks to nick,
zero answers, ever. Any nonzero count of `accept`/`decline`/`wait` from `nick` with a web provenance
falsifies the null. If the count stays at zero after this ships, the diagnosis was wrong — the
friction was not the sign-in — and the ADR should say so rather than reach for a further ergonomics
fix.

**The counter-signal worth watching:** `off_machine` misses, per ADR 170. A nonzero count is this
design working as specified _and_ the bounded-credential thread earning its existence.

**Experiment.** None. Single-human dogfood surface, no arm to compare against, no population to
split. The honest instrument is the answer count above.

## Testing

- **Through-DB integration tests** for the new route: local peer allows, off-machine refuses and
  writes the `off_machine` audit row, no CLI identity for the team returns `{available: false}`, and
  a team the vault does not know is not an error.
- **Web unit tests** for the precedence chain (watch link > stored member > auto observer), the board
  key migration, and the `/broadcast` exclusion.
- **Rail state tests** for all four action-slot states, the seat chip in both states, disable-on-any-
  answer, and the expired-credential notice.
- The perf gate (`pnpm perf:check`) applies unchanged; this adds no dependency and no new font.

## Alternatives considered

**Put the credential in the `/live` fragment**, as the watch link does. Rejected for the reason ADR
170 gave: the resulting link is permanently valuable and survives being pasted anywhere. The watch
link gets away with it because it carries a read-only, TTL-reaped observer, not a member identity.

**Extend ADR 170's nonce to `/live` and stop there** (no in-page path). Rejected because it keeps the
terminal in the loop for an ambient surface — the failure mode the `/board` datum already
demonstrates: one redemption on release day, never again.

**Mint a bounded credential now**, solving the remote admin properly. Deferred by nick's decision;
see "Two human admins" above.

**Leave the rail read-only and route answers to the CLI.** Rejected: it concedes that the surface the
human actually watches cannot act, which is the whole defect.
