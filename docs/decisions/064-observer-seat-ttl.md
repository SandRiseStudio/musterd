# 064 — Observer seats are reaped after an idle TTL

- Status: accepted
- Date: 2026-06-26

## Context

The dashboard auto-provisions a hidden observer seat per browser per team (ADR 063 + the auto-observer
flow), reusing it across refreshes via `localStorage`. Each is a real `members` row. Over time —
different browsers, cleared storage, one-off views — these `web-xxxx` observer seats accumulate. They
are invisible (hidden from roster/counts/presence) but unbounded, and ADR 063 flagged the cleanup as a
follow-up.

## Decision

The presence reaper also reaps **idle observer seats**. An observer is idle when it has no live
presence; "stale" adds an idle TTL on top of that, measured by `members.updated_at`, which we now bump
each time an observer connects (its WS `hello`). So:

- **Active browsers keep their seat.** Every visit/refresh/reconnect bumps `updated_at`, and a
  currently-connected observer is protected by its live presence row regardless of `updated_at`. A seat
  is reaped only after no connection for the whole TTL.
- **Abandoned seats are removed.** On each reaper tick, observer members with `updated_at` older than
  `observerTtlMs` (default 24h, `MUSTERD_OBSERVER_TTL_MS`) and no live presence are hard-deleted —
  cascading their presence + cursor rows (`ON DELETE CASCADE`). If a reaped browser ever returns, its
  stored token is stale; the connect fails, and the dashboard's reset path re-provisions a fresh seat.

Hard-delete, not soft-tombstone (`left_at`): the point is to *not* accumulate rows, and an observer
carries no history worth keeping — it can't send (so `messages.from_member` never references it). The
one foreign-key risk is a directed message addressed *to* an observer (`messages.to_member`), which has
no cascade; the reaper therefore skips any observer still referenced by a message, leaving those few for
manual cleanup rather than failing.

Scope: only `observer = 1` rows are auto-reaped. Participant seats are governed by the roster / durable
files (ADR 058) and are never touched by this.

## Consequences

- Observer-seat count stays bounded by *recent* watching activity (roughly one live seat per active
  browser per team), not by all-time visits.
- No behaviour change for participants or for an actively-used dashboard — the LRU-style refresh means a
  browser that keeps watching keeps its seat.
- The TTL is generous (24h) and tunable; the reaper already runs on its interval, so this adds one cheap
  delete query per tick, gated on there being stale observers.
- Re-provision on return is already handled gracefully (auto-observer + reset), so a reaped-then-returned
  browser self-heals.

## Observability & Evaluation

- **Traces:** n/a — a maintenance delete, not on the coordination envelope path. The reaper logs a
  `reap_observers` count when it removes any, mirroring the existing `reap_offline` log.
- **Eval:** n/a — mechanical lifecycle/GC policy, no agent-facing model decision to score.
- **Experiment:** n/a — no behavioural variant. The TTL is a tunable constant, not an A/B.
