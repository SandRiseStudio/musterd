# 339 — CLI agent HTTP lease reclaim

- Status: proposed — 2026-08-31
- Date: 2026-08-31

## Context

ADR 337 makes the Team agent key bootstrap-only. Routine agent HTTP authority
requires both the agent-seat credential and a short-lived lease bound to a live
Presence.

`musterd claim` is a one-shot CLI command. It claims over WebSocket, persists
the returned lease, then closes its WebSocket when the command exits. The
server correctly moves that Presence to reclaim hold, which immediately
invalidates the persisted lease. A later standalone CLI command therefore
cannot perform an agent-authenticated HTTP read or write.

## Problem

The CLI must make routine agent HTTP actions usable after a one-shot claim
without treating a disconnected Presence as live or restoring the Team agent
key as routine authority.

## Decision

1. A standalone CLI command requiring routine agent HTTP authority re-claims
   the bound seat with its persisted agent-seat credential before its HTTP
   work.
2. The command keeps that WebSocket Presence open while it makes its HTTP
   request, using the fresh lease returned by the claim.
3. The command closes the WebSocket when its work completes. The resulting
   lease is not reusable by a later process; that process re-claims again.
4. The server continues to reject a lease whose bound Presence is in reclaim
   hold. The Team agent key remains bootstrap-only, and a seat credential can
   re-claim only its own bound seat.

## Consequences

- Every standalone agent CLI HTTP action creates a short-lived Presence for
  the duration of its request.
- A stored lease is cache material for the current process only, not durable
  authority. A stale lease continues to fail closed.
- The command layer owns the WS-to-HTTP lifetime bridge. No server migration,
  protocol schema change, or relaxed authorization predicate is required.

## Observability & Evaluation

- Traces: existing claim and HTTP request logs record the normal attachment and
  request lifecycle without credential or lease plaintext.
- Eval: the CLI end-to-end suite is the dataset. Its pre-change baseline
  rejects a routine agent read after the previous claim closes; the corrected
  path re-claims and succeeds while the old lease alone remains rejected.
- Experiment: none. The regression has a deterministic local reproduction and
  is covered by the command-level test.
