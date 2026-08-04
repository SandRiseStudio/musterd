# 222 — Answerable asks on /live: the surface a human watches is the one they can act on

- Status: proposed — 2026-08-04. Authored by miley (lane `01KZ6Z1M71YT2YYBPRXZRRKSKN`). Raised by
  nick from the office itself: _"I can read them but I can't actually do anything about them."_
  Number **222**, and the fourth number this ADR has worn. It lost 219 to izzo (#628), 220 to
  stanley (#630), and 221 to stanley again (#633), all while being written.
  **The first two were hand-reading `origin/main`** — exactly the failure
  [ADR 220](220-adr-numbers-allocated-against-open-prs.md) landed to end, and a fair cop.
  **The third happened with `pnpm adr:next` used as directed, by both authors.** The tool allocates
  against the working tree, `origin/main` and every _open PR_; this branch was never pushed, so its
  claim on 221 was invisible to stanley's tool, and stanley's claim was invisible to mine. Two
  correct reads, both right at the time, same number. That is ADR 220's own pre-registered
  counter-signal firing on the day it shipped, and it is evidence for that ADR's Eval rather than a
  reason to reopen this one: a read cannot reserve, and the cheap mitigation is to **push a branch as
  a draft PR the moment it carries an ADR number**.
- Date: 2026-08-04
- Builds on: [ADR 149](149-ask-surfaces.md) (the asks rail this makes answerable),
  [ADR 147](147-human-ask-stream.md) (the ask stream and its answer acts),
  [ADR 170](170-signin-handoff.md) (the sign-in handoff this generalises, and whose declined
  bounded-credential work this deliberately leaves declined),
  [ADR 155](155-human-presence-ladder.md) (increment 3 — the shipped web-tab presence this finally
  lights up), [ADR 063](063-read-only-observer-seat.md) (the observer seat that has been `/live`'s
  only identity), [ADR 134](134-provisioning-is-localhost-trust-enforced.md) (`isLocalPeer` — the
  gate the new route reuses), [ADR 039](039-cross-network-topology.md) (one team, one daemon — why
  multi-team costs nothing here), [ADR 040](040-secured-off-loopback-bind.md) (the trust boundary
  this refuses to cross, again).

## Context

ADR 149 built the asks & approvals rail and specified, deliberately, that the auto-provisioned
observer "is read-only by construction (ADR 063) and sees the strip without buttons." That decision
was right and is unchanged here.

What ADR 149 never specified is the **transition**: how a human who is watching the office becomes
themselves. It named the advanced sign-in as the way in and stopped there, and the advanced sign-in
lives on the pre-connect form — visible only before you have connected, and unreachable afterwards.

So the rail arrived in a state nobody designed: a human is shown, above the fold, exactly what is
waiting on their decision, and is given no means to decide, no explanation for the silence, and no
route back to the form that would have helped.

## Problem

The root cause sits one level below the rail. **`/live` has no member identity slot at all.**

- `/live` stores only `musterd.live.observer.v2.<team>`. Its identity is always an observer.
- `/board` has a member slot (`musterd.board.member.v1.<team>`) and, since ADR 170, an ergonomic way
  to fill it.

A viewer who has opened `/live` once has a cached observer forever, and the only escape is clearing
localStorage by hand. `AsksStrip.tsx` gates its answer affordances on
`roster.some((m) => m.name === cfg.as)`, observers are hidden from the roster, and the buttons are
therefore not merely disabled but absent — the read-only rail is pixel-identical to an answerable one
that happens to have nothing open.

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
answer the ask stream exists to prevent.

The `/board` row is the second half of the argument. Sign-in there was exercised once, on release
day, and never again. A surface a human must deliberately navigate to does not get used. `/live` is
the surface the founder actually lives in, and it is the one that cannot be signed into.

## Decision

**Identity is per browser + team, not per route, and `/live` learns to be answerable.**

### 1. One shared member identity

Both routes read and write `musterd.member.v1.<team>`, migrating `musterd.board.member.v1.<team>` on
read. Sign in once on this browser and you are yourself on both surfaces. The observer stops being
`/live`'s identity and becomes what it always should have been: the fallback for a viewer with no
seat.

Precedence is fixed and total:

1. an explicit watch link (`?as=…#w=…`) — a URL instruction, and how a team deliberately hands the
   office to someone else; it must never be overridden by whoever last signed in on this browser;
2. the stored member identity for this team;
3. an auto-provisioned observer.

`/broadcast` reads none of it, so streaming still cannot attach a phantom human presence.

### 2. Presence is already built

Nothing new. ADR 155 increment 3 already heartbeats an authenticated `/live` tab as `online` and
already decays it through the presence timeout when the human goes quiet. It has never fired, because
no human has ever been signed in on `/live`. This ADR turns on a shipped feature that has sat dark
for want of a signed-in tab.

### 3. Two ways in

**In-page, the everyday path.** The rail offers **"Sign in as ⟨you⟩ to answer"**, one click, via a new
localhost-gated `GET /teams/:slug/local-identity` returning the identity the CLI already holds for
this team, or `{available: false}`.

**No nonce, deliberately.** ADR 170's nonce exists to make a CLI→browser _link_ inert. When the
browser asks the daemon directly there is no link to make inert, nothing to expire, and nothing to
leak into history.

**On the daemon reading the CLI's config.** This is not a new coupling. `resolveRosterRoots`
(`packages/server/src/config.ts`) already reads `~/.musterd/config.json`, and its own comment states
the rationale: _"Reading the global config keeps the daemon decoupled from the CLI package while
sharing the `~/.musterd/` home the db already lives in."_ `readLocalIdentity` is that established
pattern applied to a second key in the same file, and it refuses an agent-keyed entry for the same
reason `musterd board` does — an agent credential is a harness fact, not a person.

**From the terminal, for a cold start.** `musterd live`, a sibling of `musterd board`: `signinUrl()`
grows a surface parameter and the `#s=` redemption becomes shared code both routes call.

### 4. The rail states the state and offers the way in

The way in occupies the slot the answer will occupy, so one click swaps it for Approve/Deny in place
and the rail never moves. **ADR 149's constraint holds unchanged: one line, always, in every state.**
A blocking ask still earns a hotter colour and a faster clock, never extra room.

| Condition                                                     | The action slot holds                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Signed in as a member                                         | Approve · Deny · Deciding — 1h                                    |
| Observer, local identity available                            | **Sign in as ⟨you⟩ to answer** (accent)                           |
| Observer, no local identity (off-machine, or no CLI identity) | `sign in with a credential →` (ghost, opens the paste form)       |
| Arrived by watch link                                         | nothing — the team handed this viewer a read-only view on purpose |

A **seat chip** sits at the right end in every state: `⟨you⟩ · ⟨team⟩` when signed in, `watching` when
not. This is not decoration. With several teams on one machine you may be a different person on each,
and approving as the wrong identity is unrecoverable, so the connected seat is never implicit. The
chip is also the control: clicking it offers "watch as observer instead", which fixes the dead-end
where a cached observer could never be escaped.

## The two constraints the founder raised

### Multiple teams on one computer

Costs nothing. ADR 039's invariant is one team, one daemon, so separate projects mean separate
daemons on separate ports and localStorage is already per-origin. The per-team key is belt-and-braces
on an isolation that already holds, and `GET /teams/:slug/local-identity` resolves
`identities[<slug>]` from a CLI vault already keyed by team.

What multi-team adds is not a mechanism problem but a safety one, and it is why the seat chip is a
requirement rather than a nicety.

### Two human admins on different computers

`requireLocalPeer` gates the two ADR 170 handoff routes and now the local-identity route. For a
second admin reaching the daemon over an overlay:

- One-click and `musterd live` **correctly refuse**, and must: the route returns a member credential,
  so off-machine it would hand admin B admin A's identity.
- **The paste path works over the network.** A member credential is an ordinary HTTP bearer, not
  localhost-gated. Admin B can sign in and answer asks. The requirement is met; the ergonomics are
  not.

Closing that ergonomic gap needs the bounded-credential schema change ADR 170 declined — a migration
plus a new branch in `authMember`, an auth-path change larger than this entire arc. **Deferred to its
own thread**, by the founder's decision. This ADR's job is to make the remote path honest and
functional, and to count the refusals.

### Two admins answering the same ask

Answer buttons follow the **ask**, not the sender: they disable the moment any answer for that ask
arrives over the firehose. `deriveAsks` already folds a third party's answer correctly (it keys on
`in_reply_to`), so this is a component fix, not a derivation change. First envelope wins; the rail
settles and names who answered.

### An expired member credential

The existing 401 self-heal silently reprovisions an observer. For a signed-in member that would
silently remove the buttons again, reproducing the exact defect this ADR fixes. A member 401 falls
back to an observer **and says so**: _"your sign-in expired — sign in again."_

## Consequences

- **One identity slot, three consumers, no schema change.** Nothing new is minted, stored server-side,
  or migrated in the database. The credential's at-rest exposure is unchanged: the same localStorage
  slot the manual paste has written since #435.
- **The daemon gains one route and one config reader**, both beside existing siblings that do the
  same kind of thing under the same gate.
- **A browser answer stays a first-class answer** (ADR 149): same envelope validation, same loop-
  closure metrics, same lifecycle audit as a CLI answer. This ADR multiplies who can send one; it
  changes nothing about what one is.
- **`/live` becomes a presence source in practice**, not just on paper — which is a behaviour change
  for the ask clock (ADR 155 increment 2 modulates escalation-eagerness by presence). The absolute
  ceiling is untouched: ADR 153's hold and `stranded` semantics are invariant.
- **Cross-device sign-in remains unsolved and now has a counter.** That is the intended outcome, not
  an oversight.

## Alternatives considered

**Put the credential in the `/live` fragment**, as the watch link does. Rejected for ADR 170's
reason: the resulting link is permanently valuable, lands in history, and survives being pasted
anywhere. The watch link gets away with it because it carries a read-only, TTL-reaped observer, not a
member identity that can approve a blocking ask.

**Extend ADR 170's nonce to `/live` and stop there** — no in-page path. Rejected because it keeps the
terminal in the loop for an ambient surface, and the `/board` datum already shows where that ends:
one redemption on release day, never again.

**Mint a bounded credential now**, solving the remote admin properly. Deferred; see above.

**Show the buttons disabled with a tooltip** rather than offering a way in. Rejected: it explains the
silence without ending it, and a permanently disabled control is worse than an honest absence.

**Leave the rail read-only and route answers to the CLI.** Rejected: it concedes that the surface the
human actually watches cannot act, which is the whole defect.

## Observability & Evaluation

**Traces — this ADR adds no audit action, and that is a decision, not an omission.**

The first draft audited the successful offer (`signin.local_offered`). The exercise run killed it:
three page loads produced four rows, with nobody having done anything. ADR 170's rows record
discrete human **acts** — running `musterd board`, redeeming a nonce once. This route is probed
automatically on every load of a surface the founder leaves open all day, so a row here would not
record an act; it would record **when the human had the office on screen**. That is exactly the
human-activity trail [ADR 155](155-human-presence-ladder.md) refuses to create — _"no new record of
when the human was at their desk"_ — under the surveillance-asymmetry principle in ADR 145. A
sign-in mechanism is not a licence to start logging attendance.

Nothing is lost by dropping it, because the evaluation below never depended on it.

The **off-machine refusal is** audited, reusing ADR 170's `signin.handoff_missed` with
`reason: off_machine`. That asymmetry is the point: a refused cross-machine attempt is a security
event about something someone did, not a note about where a human was sitting. Reusing ADR 170's
action rather than minting a second keeps the cross-device signal one series across both sign-in
mechanisms instead of two half-series nobody thinks to add up. No credential is logged, and neither
is the identity-vault path, in any row.

**Evaluation.** The claim is that a human cannot answer asks because the surface they live on will
not let them be themselves. The measure is therefore not adoption but **the first ask ever answered
from a browser**, against a baseline of zero that is provable from the table above: 20 asks to nick,
zero answers, ever, from any surface. Any `accept`/`decline`/`wait` from a human with a `web`
provenance falsifies the null.

**The honest failure condition.** If that count is still zero after this ships, the diagnosis was
wrong — the friction was not the sign-in — and this ADR should be amended to say so rather than reach
for a further ergonomics fix. The `/board` handoff is the cautionary case in the record: it removed
real friction and was still used once.

**The counter-signal worth watching:** `off_machine` misses, per ADR 170. A nonzero count is this
design working as specified _and_ the bounded-credential thread earning its existence, with a number
attached.

**Experiment.** None. Single-human dogfood surface, no arm to compare against, no population to
split. The honest instrument is the answer count above.

## Increments

1. **This ADR** — the decision, the boundary, the pre-registered zero baseline.
2. **The shared member identity slot** — `musterd.member.v1.<team>`, both routes prefer it, the
   `/board` key migrated on read. Web only, no daemon change. Ships value alone: `musterd board`
   starts reaching `/live`.
3. **The rail** — the action-slot sign-in, the seat chip in both states, answer buttons that follow
   the ask, the expired-sign-in notice. Works against the paste path immediately.
4. **`GET /teams/:slug/local-identity`** — localhost-gated, `readLocalIdentity` beside
   `resolveRosterRoots`, `{available: false}` off-machine, and the off-machine refusal counted as an ADR 170 `off_machine` miss. No audit row on the successful offer — see Observability.
5. **`musterd live`** — `signinUrl()` gains a surface parameter; `#s=` redemption becomes shared code.
