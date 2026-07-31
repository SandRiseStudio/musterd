# 196 — Roster hygiene: release departed-seat claims; cap idle `web-*` observers

- Status: accepted
- Date: 2026-07-31
- Builds on: [ADR 019](019-team-remove.md) (`leaveMember` / `team remove`),
  [ADR 064](064-observer-seat-ttl.md) (idle observer TTL),
  [ADR 083](083-lanes.md) (open ⟺ unowned),
  [ADR 179](179-board-triggered-work-order-wakes.md) (gate item — lane
  `01KYQ91AWP66ZSQDYBB2M3WTKP`)
- Lane: `01KYQ91AWP66ZSQDYBB2M3WTKP`

## Context

The ADR 179 gate ledger recorded two roster smells from the 2026-07-28 dogfood day:
**stale departed-seat claims** and **~45 junk `web-*` observer members**. Live audit on
revive (2026-07-31):

- `leaveMember` / `team remove` stamps `left_at` and clears presence, but **never
  releases** the seat's in-flight lanes (`claimed` / `active` / `blocked`). The board
  then asserts "X owns this" for a name that is off every roster filter — the exact
  open ⟺ unowned lie ADR 083 forbids for the `open` state, now applied to a
  soft-removed owner.
- Observer reaping (ADR 064) **works** — the daemon logged 43 `reap_observers` on
  2026-07-29 alone — but the 24h idle TTL plus board/self-heal mint churn still lets
  the concurrent idle set crest near the measured ~45 before GC catches up. Peak
  pressure, not a broken reaper.

## Problem

1. Soft-removing a seat must free its in-flight work, or the board and future
   dispatch/review loops wake or route against a ghost owner.
2. TTL alone is a lagging bound; under heavy `/live` churn the idle set needs a
   **concurrent** bound so the roster cannot accumulate a day of disposable seats.

Out of scope: changing the 24h TTL default (still tunable via
`MUSTERD_OBSERVER_TTL_MS`); auto-releasing lanes of merely-offline seats (those are
the dispatch loop's wake targets); client mint-rate reductions (separate from this
store gate).

## Decision

1. **`leaveMember` releases in-flight claims.** After stamping `left_at`, every
   lane owned by that seat in `claimed` / `active` / `blocked` moves to `open`
   (owner + `claimed_at` cleared — the existing release invariant).
   `awaiting_acceptance` / `ready_for_review` keep the owner name so outcome
   acceptance can still derive verified-ness from the owner at close. Terminal
   lanes are untouched.
2. **Reaper sweeps already-departed owners.** The same release runs for any
   in-flight lane whose `owner_seat` matches a `left_at IS NOT NULL` member on that
   team — so historical ghosts clear without a one-shot SQL pass.
3. **Idle observer cap (additive to ADR 064).** After the TTL pass, the reaper
   keeps at most `observerIdleCap` (default **8**, `MUSTERD_OBSERVER_IDLE_CAP`)
   idle observers per team (no live presence), ordered by freshest `updated_at`,
   and hard-deletes the rest — same message-FK skip as ADR 064. Live-connected
   observers are never capped out.

## Consequences

- Soft-remove / roster-file reconcile no longer leave owned WIP on a ghost seat.
- Concurrent idle `web-*` count is bounded by the cap (± live watchers), while the
  24h TTL remains the long-stop for seats under the cap.
- No protocol / schema change. Docs: this ADR; ADR 179 gate row; `03-server.md`
  reaper / leave notes.

## Observability & Evaluation

- **Traces:** n/a — maintenance deletes + lane-state hygiene, not on the coordination
  envelope path. The reaper logs `reap_departed_claims` and `reap_observers_excess`
  counts beside the existing `reap_observers` line.
- **Eval:** n/a — mechanical GC / release invariant; no agent-facing model decision.
- **Experiment:** n/a — the idle cap is a tunable constant (`MUSTERD_OBSERVER_IDLE_CAP`),
  not an A/B.
