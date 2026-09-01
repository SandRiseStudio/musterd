# 340 — CLI lease reclaim preserves workspace

- Status: proposed
- Date: 2026-08-31

## Context

ADR 339 correctly restored routine agent HTTP authority to standalone CLI
invocations: each one re-claims its bound seat, holds that Presence through its
HTTP request, then closes it.

ADR 068 and ADR 092 already govern claims from the same Workspace. A short-lived
same-Workspace probe coexists with its live adapter; only a successor that
survives the durability grace may replace that adapter. `watchClaim` supports
the attach-time Workspace label, but ADR 339's `HttpClient` path omitted it.
The server therefore applied its intentional compatibility behavior for an
unlabelled claimant: immediate cross-Workspace supersession.

Separately, a pre-ADR-337 adapter can reconstruct and rewrite
`.musterd/binding.json` without the newly introduced agent-seat credential.
The existing writers preserve hook-owned capture fields when omitted, but did
not preserve `seat_credential`.

## Problem

Hook-side CLI calls re-claim without a Workspace label, so they evict the live
MCP adapter that is occupying the same seat. A credential-bearing binding can
also lose its agent-seat credential when a later writer omits that field.

## Decision

1. A command-scoped CLI agent re-claim sends the same resolved Workspace label
   as the MCP adapter. It therefore follows ADR 068/092: a transient hook
   claimant does not supersede the live same-Workspace adapter.
2. CLI and MCP binding writers preserve an on-disk `seat_credential` when their
   caller omits it. There is no implicit credential-drop operation.
3. A process running a pre-fix adapter cannot be changed in place. Reloading
   the MCP adapter once installs the corrected writer; if it has already lost
   its credential, a fresh authorized claim mints and persists a replacement.

## Consequences

- ADR 339's secure per-command lease lifecycle remains unchanged: the
  command-scoped Presence still exists only for the HTTP request.
- An ordinary explicit CLI claim that remains connected past the existing
  durability grace continues to replace an old same-Workspace adapter under
  ADR 092.
- No server migration or protocol-schema change is needed.

## Observability & Evaluation

- Traces: existing claim records retain the Workspace label and distinguish
  same-Workspace successors from immediate cross-Workspace supersession.
- Eval: CLI end-to-end coverage holds a live same-Workspace adapter while an
  agent HTTP re-claim runs; it must receive no `superseded` error. CLI and MCP
  binding tests each prove an omitted credential survives a subsequent write.
- Experiment: none. The reported hook sequence is deterministic and directly
  represented by the regressions.
