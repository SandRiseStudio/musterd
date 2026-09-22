# 439 — A migrated bootstrap credential has an explicit one-shot adoption path

- Status: accepted — 2026-09-22
- Date: 2026-09-22
- Lane: `01M34ZC9ZT8WS1PXDP01E3X17G`

## Context

ADR 350 makes successful scoped use—not minting—the readiness proof for retiring a Team's legacy
bootstrap credential. `musterd wire --migrate-bootstrap` atomically replaces a Workspace binding's
legacy `agent_key` with a seat-scoped `claim_seat` credential while preserving the Workspace's
routine agent-seat credential.

Routine same-seat claims correctly prefer that agent-seat credential. It is narrower authority and
does not expose the bootstrap credential to reconnects that do not need it.

## Problem

The ADR 350 runbook tells an operator to run `musterd claim <seat>` after migration. For a bound seat,
that command always selects `seat_credential` ahead of `agent_key`, so the newly migrated scoped
bootstrap credential is never presented and its `first_used_at` readiness evidence remains null.
The documented non-forced cutover path is therefore unreachable even though migration succeeds.

Changing every same-seat reconnect to prefer bootstrap authority would make readiness reachable by
weakening the routine least-privilege path. Requiring the operator to extract and pass a shown-once
credential would also defeat the protected binding that migration just wrote.

## Decision

1. `musterd claim <seat> --bootstrap` is the explicit, one-shot adoption path for the bootstrap
   credential already stored in the current Workspace binding.
2. `--bootstrap` requires an explicit seat target equal to the binding's own seat. It refuses role
   claims, implicit/bare claims, and a different seat before opening a claim session.
3. The flag selects the binding's `agent_key` even when a same-seat `seat_credential` exists. It does
   not accept or reveal credential material and does not change the binding after the normal claim
   result.
4. Claims without `--bootstrap` retain the existing least-privilege precedence: a same-seat
   reconnect uses `seat_credential`; bootstrap authority remains the fallback for initial claims.
5. `musterd wire --migrate-bootstrap` and the cutover runbook print the exact explicit command. The
   command remains safe while the seat has an active Presence: the claim protocol's normal
   same-Member reconnect semantics apply.
6. No protocol schema, server readiness rule, credential kind, or MCP reconnect behavior changes.

## Consequences

- A migrated Workspace can produce ADR 350's observed-use evidence without copying a secret or
  making bootstrap authority the routine reconnect credential.
- The operator must take one explicit post-migration action before the seat becomes cutover-ready.
- Existing scripts and adapters keep their current authority selection because the new behavior is
  opt-in and CLI-only.
- A mismatched or ambiguous adoption attempt fails locally before it can create a request, Presence,
  or other server effect.

## Observability & Evaluation

- Traces: the existing credential-use audit records the scoped bootstrap credential's first
  successful claim; the CLI emits no credential material and adds no new trace payload.
- Eval: CLI integration tests compare ordinary same-seat reconnect with `--bootstrap`, prove the
  selected credential changes only for the explicit matching-seat path, and prove invalid targets
  fail before a claim session. Wire tests pin the exact follow-up command.
- Experiment: migrate one disposable bound Workspace, observe it remain unmet, run the printed
  `musterd claim <seat> --bootstrap` command, and verify non-forced cutover readiness removes only
  that seat while ordinary reconnects continue to succeed with its agent-seat credential.
