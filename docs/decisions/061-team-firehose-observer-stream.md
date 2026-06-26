# 061 — Team firehose: an observer can stream all of a team's communication

- Status: accepted
- Date: 2026-06-26

## Context

The web dashboard's first real surface is a live view of **all** of a team's communication —
agents and humans, every act, streaming in real time (design: the "Live Comms" split-canvas,
`musterd / Dashboard` Figma). Building it surfaced a gap in the transport.

Delivery today is **recipient-routed**. `routeEnvelope` (`protocol/route.ts`) resolves an envelope's
recipients (the addressed member, or — for `to.kind` `team`/`broadcast` — everyone on the team except
the sender) and pushes a `deliver` frame to each via `hub.deliver(memberId, …)`. The `subscribe`
frame exists but does nothing beyond echoing `subscribed` ("no filtering yet").

Consequence: a connection only ever receives messages **addressed to its own member** plus
`to:team`/`broadcast` traffic. A directed `David → Olive` message reaches Olive and no one else. An
observer dashboard connected as a third seat would therefore **miss every directed DM between other
members** — it cannot show "all communication," only its own slice. Backfill has the same shape:
`GET /teams/:slug/inbox` is per-member (messages to me), so even the initial page load can't render
the whole team's history.

## Problem

A read-only observer (the dashboard, a future audit tool, `inbox --watch --all`) needs the **whole
team stream** — every persisted envelope, live and historical — without changing the privacy of
normal recipient-routed delivery, and without a new identity model (v0.2 is still localhost-trust;
the v0.3 seat/governance work owns real authorization).

## Decision

Add a **team firehose** as an opt-in subscription scope plus a full-team history endpoint. Two small,
additive pieces; no change to default delivery.

1. **`subscribe` gains a scope.** `SubscribeFrame.scope` becomes `'team' | 'team-all'` (default
   `'team'`, unchanged). `'team-all'` registers the connection in a per-daemon firehose set
   (`Hub.subscribeFirehose`); `subscribed` echoes the granted scope. `Hub.remove` clears firehose
   membership alongside the member index.

2. **Routing fans out to the firehose too.** After the recipient-delivery loop, `routeEnvelope`
   calls `hub.broadcastFirehose(teamId, deliverFrame, skip)` where `skip = recipients ∪ {sender}`.
   The skip set means no connection is double-sent: anyone who already got the envelope as a recipient
   (and the sender, who got an `ack`) is excluded; everyone *else* watching the firehose sees it. So
   the firehose is exactly "every envelope on the team," deduped at the member level.

3. **Full-team history.** `GET /teams/:slug/messages?since=<ts>&limit=<n>` returns the whole team
   timeline as envelopes (reusing the already-present `listTeamMessages`, extended with
   `since`/`limit`), so the dashboard backfills then live-tails. Authed via `authTouch` like `/inbox`.

**Authorization is intentionally flat for v0.2.** Any authenticated team member may open the firehose
or read full history — the same localhost-trust stance as `reclaim`/`remove` (ungated, with a noted
v0.3 seam). The firehose is *read* only: it is a delivery fan-out, not a new send path. A dedicated
read-only observer identity (a seat that watches without appearing as a working teammate) is a
follow-up, not required to ship — an observer can watch as any seat today.

## Consequences

- The dashboard can show **all** communication: backfill via `/messages`, live-tail via `team-all`.
  This is what makes the Live Comms view honest rather than a partial feed.
- Default delivery, inbox, cursors, and existing clients are untouched (`subscribe` default is still
  `team`; the firehose is opt-in and additive). `inbox --watch` keeps its recipient-scoped behavior.
- The firehose is **live-only** (it joins the stream at subscribe time); history before the socket
  opened comes from `/messages`. Client = "GET /messages, then subscribe `team-all`, dedupe by
  envelope `id`" — the same dedupe clients already need for at-least-once delivery.
- Privacy note recorded for v0.3: once governance lands, the firehose is the natural place to enforce
  "who may observe whom." Until then it inherits localhost-trust, like every other v0.2 operator path.
- Backpressure is out of scope at localhost volumes; if a slow observer ever matters, the firehose set
  is the single choke point to add per-connection buffering to.

## Observability & Evaluation

- **Traces:** firehose fan-out rides the existing `withEnvelopeSpan` around `routeEnvelope`, so a
  delivered envelope's span already covers the firehose broadcast. The route log now carries a
  `firehose_delivered` count beside the existing `delivered`, so one line shows recipient vs observer
  fan-out. No new span — it's one more push on the established route path.
- **Eval:** n/a — purely transport/read plumbing, no agent-facing model decision to score. Worth
  recording the adjacency, though: `GET /teams/:slug/messages` is the whole-team timeline export, which
  is exactly the substrate the coordination-trace dataset work wants (roadmap `coordination-dataset`,
  ADR 056). When that lands, this endpoint — not a bespoke dump — is its read path; a dataset/baseline
  belongs to that ADR, not this one.
- **Experiment:** n/a — no behavioral variant to A/B. The firehose is the observation surface future
  team-outcome experiments read *through*, not a thing under experiment itself.
