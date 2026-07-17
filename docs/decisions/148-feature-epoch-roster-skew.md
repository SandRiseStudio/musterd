# 148 — Feature epoch: a meaningful roster skew signal in place of the build-SHA "stale" chip

- Status: accepted — 2026-07-17
- Date: 2026-07-17

## Context

ADR 135 gave every runtime a build stamp and the roster a per-member `stale` chip: it lit, in warn
amber, whenever a present member's attested build SHA differed from the daemon's. The intent was sound
— kill the silent "but I merged it, why isn't it live?" lie — but the surfacing was wrong for an
end-user roster.

Two problems, surfaced in a dogfood session:

1. **It cried wolf.** In a fleet of drifting worktrees (the normal resting state), nearly every seat's
   SHA differs from the daemon's. So the chip was almost always lit — and an amber "stale" tag reads as
   *this agent is broken*, when it only ever meant benign build drift.
2. **The alarming case can't actually happen here.** Genuine wire-incompatibility is already refused at
   the handshake: `ws.ts` throws `version_mismatch` when `frame.v !== PROTOCOL_VERSION`. So by the time
   a member is *present* on the roster, it is protocol-compatible by construction. A "stale/incompatible"
   chip on a present member is therefore a structural false positive.

The only data the chip had was the opaque SHA (differs constantly, no notion of "how far" or "does it
matter") and `PROTOCOL_VERSION` (`musterd/0.3`, always equal for present members). Neither can tell
benign drift from a gap worth acting on.

## Problem

We want the roster to flag a seat **only when the skew is real and actionable** — the seat is running
code old enough to lack a capability the team now has — and to say so *calmly*, not as an alarm.
`PROTOCOL_VERSION` is too coarse (breaking-only, bumps ~never) and the build SHA is too fine (bumps
always, meaning nothing). There is no signal in between.

## Decision

Introduce a **feature epoch**: a monotonic capability counter, attested on the same rails as the build
stamp, that the roster compares to decide whether a live seat is genuinely behind.

### 1. `FEATURE_EPOCH` — a pure protocol constant

`packages/protocol/src/feature-epoch.ts` exports `FEATURE_EPOCH` (currently `1`). It is the *soft* axis
next to `PROTOCOL_VERSION`'s *hard* one: a seat a few epochs behind still connects and works — it just
lacks later features. **Bump by exactly 1** when a change lands that gives the daemon (and fresh seats) a
capability an older seat cannot participate in or render — a new act, a new MCP tool, a roster-affecting
field. **Do not** bump for bugfixes, refactors, or web-only tweaks. A missed bump only makes the hint
slightly less sensitive (fails safe); it is a courtesy signal, never a gate.

### 2. Attested like `build`, on every rail

The epoch rides the exact rails the build stamp does:

- **Wire**: `epoch?` on `ClaimFrame` (inbound) and `PresenceSchema` (outbound); a `presence.epoch`
  column (migration v23), sticky across ambient re-attests via `COALESCE` like build/model.
- **Clients**: the MCP adapter and CLI attest `FEATURE_EPOCH` on claim. Unlike build (read from a dist
  stamp, so it can be absent), the epoch is a compiled-in constant — our own clients always attest it.
- **Daemon**: `/health` reports the daemon's own `FEATURE_EPOCH` (the epoch of the code it runs),
  alongside `build`.

Older clients that don't attest read `null` everywhere and simply never trigger the hint.

### 3. The roster renders skew from the epoch, not the SHA

`isFeatureBehind(member, daemonEpoch)` is the single, pure decision (`format.ts`): a **live** seat whose
attested epoch is a known number **below** the daemon's known epoch is "behind". Every other case is
fail-quiet — offline seats (a seat that isn't running can't be behind), an unknown epoch on either side
(never guess), and equal/ahead (equal is current; ahead means the *daemon* lags, which its own
`service status` warning already surfaces).

The chip is retoned from warn amber to the roster's muted neutral and relabelled `behind`; its tooltip
names the epoch gap and keeps the build SHAs as operator detail. The build ref is now *only* tooltip
detail — never itself a trigger.

### What this retires

The build-SHA `stale` chip (`.lc-seat__stale`, the `memberBuild !== daemonBuild` trigger). Build
provenance is retained everywhere — it is just no longer promoted to a visible per-member alarm.

## Consequences

- The roster is quiet in the common case (drifting-but-current fleet) and speaks only when a live seat
  is a real feature epoch behind — which is exactly the reload-me signal an operator can act on.
- A new maintenance ritual: bumping `FEATURE_EPOCH` when a client-visible capability lands. It is
  low-stakes (fails safe) and documented at the constant, but it is a discipline, like the
  `PROTOCOL_VERSION` and DB-migration rituals.
- The epoch is attested, never verified (like model/build): a client could under-report and hide its
  own "behind" hint. Acceptable — the signal is a courtesy to operators, not a security boundary.
- `PROTOCOL_VERSION` stays the hard gate; nothing about the connect-time compatibility refusal changes.

## Observability & Evaluation

**Traces** — the instruments are the existing presence + health surfaces, now epoch-bearing (no new
audit shape; this is display-grade skew, not a coordination act — ADR 051). The daemon's own epoch is on
`/health` beside `build`/`v`/`schema`; each seat's attested epoch is on its roster-payload presence entry
and its `presence.epoch` column, so a behind-seat is inspectable by query without the UI. The roster
tooltip names the exact gap (member epoch vs team epoch, with the build SHAs as detail).

**Eval** — `isFeatureBehind` is unit-tested for the full truth table: behind → flagged; equal/ahead →
not; unknown member or daemon epoch → not; offline → not (`format.test.ts`). The wire round-trip +
`COALESCE` stickiness across an ambient re-attest, and the absent-epoch → `null` degrade, are covered in
`store.test.ts`; `ClaimFrame` epoch parsing (optional, non-negative integer) in
`claim-handshake.test.ts`. Dataset: the dogfood team's live roster/`presence` rows. Baseline: the old
build-SHA chip, lit on nearly every present seat (this session: `miley` and `gptbot` both `stale` against
a daemon 15 commits ahead). Headline measure: after this ships, the roster shows **zero** `behind` chips
in a drifting-but-current fleet, and exactly one only when a real `FEATURE_EPOCH` bump lands and a seat
is left running the older build — the inverse of the old always-lit chip.

**Experiment** — the natural before/after is the next `FEATURE_EPOCH` bump: land a client-visible
capability behind an epoch increment, then confirm (a) a seat still on the prior build shows `behind`
while current seats stay quiet, and (b) reloading that seat clears it. Guard metric (must _not_ move): an
offline seat, or a seat with an unknown epoch on either side, never shows the chip — if one does, a
fail-quiet branch leaked.
