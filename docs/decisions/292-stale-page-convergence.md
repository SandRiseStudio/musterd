# 292 — Stale-page convergence: the bundle stamps its build, an open page reloads once onto the served one

- Status: accepted
- Date: 2026-08-19
- Relates to: ADR 062 (daemon serves the web same-origin), ADR 132 (the daemon-served viewer is THE
  viewer), ADR 135 (daemon buildRef on /health), officeRoom's route-parity contract
  (packages/web/src/live/officeRoom.ts)

## Context

The `/live` publisher (ADR 132) builds origin/main every 60 seconds and **swaps the web-root
atomically under a running daemon** — no restart, no WebSocket drop, no signal any open page can
see. A page therefore runs the bundle it loaded until something external reloads it. For a laptop
browser tab that is a shrug; for the two long-lived surfaces it is the product: the broadcast
machine's Chrome (its page IS the Twitch stream) and any wall-mounted `/live` dashboard.

Observed 2026-08-19: off-shift lighting merged (#916) and published within minutes, and the live
stream kept broadcasting the office as it looked days earlier — the stream's page predated the
merge, and nothing existed to tell it so. `officeRoom`'s parity contract (nick, 2026-08-03: "live
and broadcast should always be in sync") was doing its job *within* the stale build — it guarantees
the two routes agree on the room's facts, and cannot say anything about which build renders them.

Two non-mechanisms were confirmed before this: the web bundle contains no reload path at all, and
the WS `version_mismatch` code is the protocol handshake guard — it *dead-ends* a mismatched
client (correctly — a reconnect war is worse), never refreshes it. The daemon's `/health` `build`
(ADR 135) names the **daemon's** checkout, which is the wrong token: web assets and daemon restart
on different cadences, so comparing a page against it can demand a reload no reload satisfies.

## Decision

The classic version-stamp pattern, entirely inside the web build:

1. **One id per build, in two places.** `vite build` computes the checkout's sha (timestamp
   fallback) and bakes it into the bundle as `__WEB_BUILD__` *and* writes it to `build.json`
   beside `index.html`. The daemon's static serving (ADR 062) publishes it with no server change.
2. **Visible pages poll it slowly.** `buildSync.ts` fetches `/build.json` every 5 minutes —
   hidden pages skip the poll entirely (the perf contract's idle-cost rule) — and compares it to
   the page's own id.
3. **A mismatch reloads once, ever, per served id.** The attempt is recorded in sessionStorage;
   a host that keeps serving a stale bundle against a fresh stamp gets one attempt, never a loop.
   After a successful reload the ids are equal *by construction* — one build produced both.
4. **Absence disables.** Dev pages have no `__WEB_BUILD__`; hosts without a `build.json` answer
   nothing; either way the loop is inert. `?build-sync=<ms>` overrides the cadence for testing,
   the same explicitly-present-only contract as `?light=HH`.

Wired once in `useLiveStream`, so `/live` and `/broadcast` both converge; credentials play no part
(a page stuck at a login error is still worth un-staling).

## Why not push it down the WebSocket

The WS is the team-data channel. It does not drop on an asset swap (the trigger would miss every
ordinary deploy), adding the stamp to its frames couples bundle freshness into the coordination
protocol, and the like-for-like token would still have to come from the web-root — at which point
HTTP already serves the answer. A 50-byte no-store fetch per visible page per 5 minutes is the
entire cost; convergence is bounded at ~6 minutes end-to-end behind the publisher's 60s poll.

## Observability & Evaluation

- **Traces:** a converged page is visible in the publisher's own artifacts — `build.json` in the
  web-root names what is served, the page's `__WEB_BUILD__` names what runs, and
  `sessionStorage['musterd-build-sync-reloaded-for']` records the one attempted reload with the id
  it targeted. `curl /build.json` against the daemon answers "what should every page be running?"
  in one line.
- **Eval:** after the next few merges that touch `packages/web`, read the stream: did the Twitch
  broadcast pick up each change within ~6 minutes without a manual bounce? If a stale broadcast is
  ever again diagnosed by a human noticing old pixels — rather than never happening — the poll
  cadence or the trigger model is wrong and this ADR reopens. The falsifier in Consequences
  (double-reload / dev-reload) is checkable in any page's sessionStorage plus its network log.
- **Experiment:** run once before merge, not indefinitely — serve a built dist statically, open
  `/live?build-sync=2000`, swap `build.json` to a foreign id: exactly one reload, then stable
  through further polls despite the persisting mismatch (executed 2026-08-19, both held). The
  baseline it beats is the status quo measured the same day: a merged visual change, published
  within minutes, never reaching the open broadcast page at all.

## Consequences

- A deploy reaches every open surface within minutes — including the Twitch stream's Chrome —
  instead of "whenever someone remembers the page is old". The mid-stream reload is a one-second
  flicker; a days-stale office was worse on every axis.
- Stale-chunk failures (an old page lazy-loading a hashed chunk the swap deleted) shrink to the
  poll window instead of persisting until a human notices.
- Pages loaded *before* this ships have no sync loop; the last manual bounce is the migration.
- The falsifier: a page that reloads more than once for one served id, or any reload in dev —
  either voids the design and the sessionStorage guard needs re-examination.
