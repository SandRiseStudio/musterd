# 347 — An agent session lease renews over the live socket

- Status: accepted — 2026-09-01
- Date: 2026-09-01

## Context

ADR 337 §3 requires every routine agent HTTP request to carry a short-lived session lease
minted by a claim and bound to that Presence; §4 says reconnection makes a fresh claim to
receive a fresh lease; §5 says WebSocket authority is connection-bound and the `occupied`
frame "always returns the current lease". The lease lives five minutes.

The MCP adapter holds one WebSocket Presence for its whole session and drives its
HTTP-backed tools (`lane_open`, `team_send`'s HTTP paths, and twenty-five more) with the
lease it received in `occupied`. Nothing renewed it: no timer, no frame, no handling of
the refusal. Measured 2026-09-01 (lane 01M1FC77F2): every adapter's HTTP tools were
refused with `invalid, expired, or revoked agent session lease` five minutes after claim
and stayed refused until a reconnect happened to mint another. Five seats hit it in one
day and attributed it to three different causes.

## Problem

An adapter with a live, authenticated Presence has no way to keep the HTTP authority that
Presence is supposed to back, and the only remedy — a fresh claim — is the event ADR 339/340
and #1138/#1143 spent a day making rare.

## Decision

1. While a connection holds an agent Presence, the daemon renews its session lease over
   that connection: on the first heartbeat inside the renewal window (two minutes before
   expiry) it mints a new lease for the same Presence and pushes it as a `lease` frame
   `{session_lease, expires_at}`. Amends ADR 337 §5: the `occupied` frame returns the
   current lease *and* the connection is handed each renewal before the current one expires.
2. The previous lease is not revoked by renewal. It dies at its own expiry, so a request in
   flight under it still lands. Revocation stays exactly ADR 337 §3's list.
3. The adapter adopts the frame for every subsequent HTTP request and writes it into the
   binding of the seat it holds — only when the on-disk binding still names that seat — so
   a CLI hook in the same Workspace presents a live lease as well.
4. Human and observer connections receive no `lease` frame; they carry no HTTP lease.
5. Renewal is audited by lease id, never plaintext, as `agent_session_lease.renewed`.

## Consequences

- A long-lived adapter keeps its HTTP tools for as long as its socket lives. A reconnect
  still claims, as ADR 337 §4 says.
- An adapter older than this frame ignores it (frames are parsed, not schema-validated,
  on that path) and keeps the five-minute behaviour until reloaded.
- The window is two minutes: eight adapter heartbeats fall inside it, so one dropped
  heartbeat never leaves an adapter without authority.
- ADR 346's hook path is unchanged; with rule 3 the same-Workspace hook usually finds a live
  lease and never needs its one claim.

## Observability & Evaluation

- Traces: `agent_session_lease.renewed {previous, lease, source:'heartbeat'}` per renewal;
  a seat whose adapter is live for more than five minutes and shows no renewed row is the
  regression signature.
- Eval: `packages/server/src/transport/lease-renewal.test.ts` — the dataset is a real
  daemon with a claimed agent socket; the baseline (pre-change) never emits a `lease`
  frame and the aged lease is refused. `packages/mcp/src/client.lease.test.ts` pins
  adoption and the same-seat-only write.
- Experiment: falsify on a live seat — call any HTTP-backed tool at five minutes and ten
  seconds after claim without a reconnect. Before: refused. After: accepted, with one
  `renewed` row for the seat.
