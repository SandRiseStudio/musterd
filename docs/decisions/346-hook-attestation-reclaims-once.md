# 346 — A hook attestation reclaims once, never evicts, and remembers it

- Status: accepted — 2026-09-01
- Date: 2026-09-01

## Context

ADR 337 requires every routine agent HTTP request to carry a session lease minted by a
claim and bound to that claim's Presence, and states (§4) that reconnection makes a fresh
claim to receive a fresh lease. The lease lives five minutes. ADR 339/340 gave ordinary CLI
commands that reclaim, scoped to the same Workspace label the adapter sends; #1138 and
#1143 then took it away from hook-driven reads, because a claim per tool call from a
second Workspace superseded the live adapter on every seat (the 2026-09-01 claim storm).

The session-attestation push (`musterd session start|end`, and the tool-boundary heal of
ADR 336) presented only the lease stored in `binding.json`, which is written once at claim
and never renewed. Measured on seat ryder, 2026-09-01: every attestation more than five
minutes after the claim was refused (`401 invalid, expired, or revoked agent session
lease`) and the refusal was swallowed as "daemon unreachable" — the local slot was written
and the ledger got no row. The residency ledger undercounted every seat from #1119 on,
heaviest on `session_ended`.

A one-shot cannot keep a lease alive: closing its claim socket releases the Presence
(`held_until`), which the server reads as a dead lease — a second hook presenting the
lease the first had just minted was refused in about one run in four, the rest being the
close still in flight.

## Problem

The attestation path must obtain a fresh lease when its stored one is refused, without
reintroducing either half of the storm: a claim per tool call, or a claim from one
Workspace that supersedes an adapter live in another.

## Decision

1. On a lease refusal — and only on the server's two lease refusals, never on a refused
   credential, a refused seat, or an unreachable daemon — the attestation makes exactly one
   fresh claim, attests under it, and closes it. It never claims before presenting the
   stored lease.
2. Before opening that socket it reads the roster. If the seat is live (`online` or `away`)
   in any Workspace other than its own, it does not claim; the slot stays unattested. A
   roster it cannot read is treated the same way. Same-Workspace coexistence remains the
   server's under ADR 340.
3. The minted lease is not written back to the binding; it is dead once the socket closes.
4. `SessionCaptureSchema` gains a local-only `claim_attempted_at`. A session event
   (`start`, `end`) may spend one claim; the tool boundary, which runs on every tool call,
   attests with what it holds but never claims once the slot's claim is spent. A new slot
   starts unspent.

## Consequences

- Ledger rows land again for hooks past the five-minute lease, at a cost of one WS claim
  per session event, not per tool call.
- A SessionStart in a second Workspace while the adapter is live in the first attests
  nothing, by design. That shape was silently evicting; it is now a recorded gap. The wiki
  page `residency-ledger-undercount` names it for an analyst.
- A lease that outlives its socket, or a renewal that needs no Presence, would remove the
  per-event claim entirely. That is a server decision under ADR 337 and is not made here.

## Observability & Evaluation

- Falsifier: `packages/cli/src/cli.e2e.test.ts`, "a session attestation with a refused
  lease reclaims once and lands on the ledger" — red without the fix with
  `expected [] to equal ['residency.session_captured']`.
- Unit cases pin: one claim per refusal; no claim on an accepted lease, an unreachable
  daemon, a seat live elsewhere, or an unreadable roster; one claim per slot across
  repeated tool boundaries; a fresh session event may claim again.
- Live: the ADR 336 owed arm was observed on this build, 2026-09-01 13:26–13:28 — the
  probe could not land a row without it.
