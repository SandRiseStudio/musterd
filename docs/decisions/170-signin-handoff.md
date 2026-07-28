# 170 — Sign-in handoff: the CLI walks you into the browser, carrying nothing you can leak

- Status: proposed — 2026-07-28. Authored by miley (lane `01KYMQ051PMERNH8KFPVXJRPQC`). Approved by
  nick this session as the follow-up thread the writable-board spec deferred. Number **170** — next
  free above ADR 169 at branch time.
- Date: 2026-07-28
- Builds on: [ADR 104](104-work-items-board-insight-layer-web.md) (the board this signs you into),
  [ADR 145](145-human-role-refounded.md) (human work identity — the reason a human needs to _be
  themselves_ on the web at all), [ADR 063](063-read-only-observer-seat.md) (the `#fragment`
  secret-carrying convention this reuses and then improves on),
  [ADR 134](134-provisioning-is-localhost-trust-enforced.md) (`isLocalPeer` — the gate both new routes reuse),
  [ADR 155](155-human-presence-ladder.md) (an authed web session marks you present — what a
  successful sign-in also buys), [ADR 040](040-secured-off-loopback-bind.md) (the trust boundary this
  deliberately refuses to cross).

## Context

The writable board (item 5, PRs #435/#439/#443) made `/board` a place a human works: create a lane,
claim it, hand it off, close it. Every one of those verbs is member-authed, so the board first has to
know **who you are** — and today the only way to tell it is to paste a raw `mscr_` credential into a
password field.

The spec that shipped the board called this out and deferred it: nick approved the paste "for now"
and asked for it to be improved as its own thread. This is that thread.

The friction is not the typing. It is that **the paste flow makes a human handle a permanent secret
by hand** — find it, copy it, paste it — and the natural workarounds (keeping it in a note, mailing
it to yourself) are all worse than the flow they shortcut. The founder record already shows what
happens to a human-facing step that costs more than it is worth: it does not get done. This one is
load-bearing for the entire human-work-identity arc, because a human who does not sign in owns no
lanes, and the insight rail can never say "the team is blocked on nick."

Two facts about the current system shape the whole design:

- **The CLI already holds the credential.** `~/.musterd/config.json` carries
  `identities[team] = {name, key: mscr_…}`. Nothing needs to be minted; the secret the browser needs
  is already sitting on the same machine, one process away.
- **A member cannot hold two credentials.** `members.credential_hash` is a single column, and
  `mintCredential` overwrites it. Minting a fresh, scoped, short-lived credential for the same member
  would _invalidate their CLI credential_ — the classic "sign in over here, get signed out over
  there" defect. Any design that mints is a schema change (a second table, or grants-as-HTTP-auth),
  and that is a much larger, auth-path-touching change than this friction justifies.

## Decision

**`musterd board` hands the browser a 60-second, single-use nonce — never a credential — and the
daemon relays the credential the CLI already had.**

The CLI resolves your identity for the team from its own config, POSTs `{member, credential}` to the
daemon (localhost only), and receives an opaque `nonce`. It opens
`…/board?team=<slug>#s=<nonce>`. The page redeems the nonce exactly once over `GET`, receives
`{as, credential}`, stores it in the same per-team localStorage slot the manual paste already writes,
strips the fragment from the address bar, and connects. You never see a secret; the board is simply
you, signed in.

**What the nonce is, and is not.** It is a bearer handle to a one-time relay, held in daemon memory,
expiring in 60 seconds, deleted on first read. It is not a credential, not persisted, not derived
from the credential, and not accepted anywhere else. After the browser redeems it — or after a
minute, whichever comes first — the string in your history is inert.

**Both routes are localhost-gated** (`isLocalPeer`, ADR 134). This is the load-bearing constraint,
not a hardening detail: a link that a phone could redeem is a link that carries a permanent
credential onto a device the trust boundary never covered (ADR 040). Gating the redemption end means
the "text it to myself" failure mode returns _"this link only works on the machine that made it"_
rather than silently succeeding and moving nick's identity to his phone. **Signing in on another
device is out of scope for this ADR** — it needs a bounded credential, which needs the schema change
above, and it should be designed as its own thing rather than smuggled in as a side effect of an
ergonomics fix.

**The paste stays.** `MemberSignIn` is untouched, and the connect form remains the fallback for
every case the handoff cannot serve: a stale link, a daemon on another host, a browser on another
machine, or a human who simply prefers it. This ADR removes a step from the common path; it does not
remove the path.

## Mechanism

**Daemon — an in-memory relay, no schema change.**

- A `Map<nonce, {team, member, credential, expires_at}>`, capped and swept on write, alongside the
  other ephemeral presence state. Nothing durable; a daemon restart drops pending handoffs, which is
  correct — a handoff older than a minute is already void.
- `POST /teams/:slug/signin-handoff` — `isLocalPeer` **and** the posted credential must authenticate
  as the named member (`authByCredential`). The second check is what stops the route from being an
  identity-laundering primitive: you can only stage a handoff for a seat whose credential you already
  hold, so the route grants no authority the caller did not already have. Returns
  `{nonce, expires_in_ms}`.
- `GET /teams/:slug/signin-handoff/:nonce` — `isLocalPeer`, consume-on-read (delete before
  responding), returns `{as, credential}`. An unknown, expired, or already-redeemed nonce is a plain
  `404` with one message: _"that sign-in link was already used or has expired."_

**CLI — `musterd board [--team <slug>] [--no-open] [--print]`.**

- Resolves the identity for the team from config, stages the handoff, opens the URL with the
  platform opener (`open` / `xdg-open` / `start`), and prints **the board URL without the fragment**
  so the terminal scrollback never carries even the nonce.
- `--print` emits the full link for the rare manual case, with a one-line note that it is
  single-use and machine-local. `--no-open` stages without launching.
- Refuses cleanly when the team has no human identity in config (_"this folder's seat is an agent —
  sign in as yourself with `musterd join`"_), which is also the honest error for an agent seat that
  runs it by reflex.

**Web — `/board` learns one more URL shape.**

- On mount, `#s=<nonce>` → redeem → on success store `{as, token}` under the existing
  `musterd.board.member.v1.<team>` key, `history.replaceState` the fragment away, connect as a
  member. On failure, fall through to the normal connect form carrying the daemon's message.
- The `?team=…` and remembered-credential paths are unchanged, and the observer path is untouched.
- The fragment is stripped **before** the redeem resolves, so a slow response cannot leave the nonce
  sitting in the address bar for a shoulder to read.

## Alternatives considered

**Put the credential straight in the fragment** (the `/live` watch-link shape, ADR 063). Half a day
cheaper and no daemon work at all: the CLI already has the secret, and a fragment never reaches the
server. Rejected because the resulting link is _permanently_ valuable — it lands in browser history
and survives being pasted into a chat, and the failure mode of the obvious misuse ("text it to my
phone") is a permanent credential on an untrusted device rather than an error message. The watch link
gets away with this because it carries a **read-only, TTL-reaped observer** seat, not a member
identity that can close lanes.

**Mint a short-lived credential for the member.** The security posture's blessed shape for a
shareable secret (bounded, single-use, revocable — the grant pattern). Rejected _for now_ on cost:
`credential_hash` is one column, so this is a migration plus a new branch in `authMember`, and
getting it wrong signs the human out of their CLI. It is the right foundation for cross-device
sign-in, and that is the thread that should pay for it.

**Model the handoff as a grant** (`store/grants.ts` already has TTL, single-use, revoke, audit).
Genuinely tempting. Rejected because grants are consumed by the WS claim handshake, not HTTP bearer
auth, so reuse means teaching `authMember` a second credential shape — the same auth-path surgery as
above, for a token that lives sixty seconds and never needs revoking because it cannot outlive the
attempt.

**Have the browser ask and the CLI approve** (roster click → ask → approve in the terminal). The most
musterd-native shape, and it needs no new secret transport at all. Rejected as the wrong altitude for
this problem: it turns a one-command action into a two-surface handshake, and the ask stream exists
for decisions a human must weigh, not for proving you are sitting at your own keyboard.

## Security

- **No new authority.** The POST requires a credential that already authenticates as the named
  member, so the route hands back nothing the caller could not already do. It is a courier, not an
  issuer.
- **Nothing durable.** The relay is memory-only; nothing about a handoff survives a restart, and no
  new secret is written to disk on either end. The credential's at-rest exposure is unchanged: it
  lands in the same localStorage slot the manual paste has written since #435.
- **Bounded blast radius.** A leaked nonce is worth, at most, one sign-in from the same machine
  within sixty seconds. A leaked _link_ is worth nothing off that machine.
- **No secrets in logs.** The nonce rides the fragment (never sent to the server), the CLI prints the
  fragment-free URL by default, and the credential moves only in a POST body and a GET response over
  loopback.
- **Refused at the boundary, loudly.** Off-machine redemption is a 403 that names the reason, so the
  cross-device case surfaces as a product gap to design rather than a hole to discover.

## Observability & Evaluation

**Traces.** Two audit rows on the existing member-audit channel: `signin.handoff_staged`
(`{member, surface: 'cli'}`) and `signin.handoff_redeemed` (`{member, surface: 'web', age_ms}`).
Failed redemptions record `signin.handoff_missed` with a `reason` of `expired | unknown | consumed |
off_machine` — the miss reasons are the interesting series, because each one names a different defect
(a slow human, a lost nonce, a double-open, a device we do not serve). Nonces themselves are never
logged, in any row.

**Evaluation.** The claim is that this removes a step humans were skipping, so the measure is
adoption, not latency: **the share of member-grade `/board` sessions arriving by handoff rather than
by paste**, read off `signin.handoff_redeemed` against the count of web member sessions (ADR 155
attaches a presence row to each, so the denominator already exists). Pre-registered baseline: **zero
handoff sign-ins, and exactly one human — nick — who has ever pasted a credential into `/board` at
all.** The bar is deliberately low and honest: if nick's own sign-ins stop going through the paste
field, the friction was real and is gone. If he still pastes, the command did not fit his hands and
the design is wrong regardless of how clean the mechanism is.

**The counter-signal worth watching:** `off_machine` misses. A nonzero count is not this ADR failing
— it is the cross-device thread demanding to exist, with a number attached. That is the datum that
would earn the bounded-credential schema change this ADR declined to make.

**Experiment.** None. This is an ergonomics change on a single-human dogfood surface; there is no
arm to compare against and no population to split. The honest instrument is the adoption count above.

## Increments

1. **This ADR** — the decision, the boundary, the pre-registered baseline.
2. **Daemon + protocol** — the handoff store, both routes, their audit rows; through-DB tests
   covering consume-once, expiry, the off-machine refusal, and the identity-laundering refusal.
3. **CLI + web, verified end-to-end** — `musterd board`, the platform opener, the `#s=` consumption
   on `/board`, and a live run: one command, a signed-in board, an inert link.
