# 342 — Multi-admin decision concurrency

- Status: superseded by [ADR 343](343-defer-multi-admin-delegation.md) (2026-09-04, recorded by
  ryder on lane `01M1MMKHX8WXASZT6CGWPNJ4ES`) — ADR 343 withdrew this ADR's transaction requirement
  in its own text on 2026-09-01 and only this line still said `proposed`. **Decisions 1 and 2 below
  are not in force.** Decisions 3 and 4 were never contested — see **What survives** below.
- Date: 2026-09-01

## Context

The current model already permits multiple human Members with `is_admin`.
Every admin can list and decide the same pending claim request. The store
conditionally changes a request from `pending`, but the HTTP decision route
currently reads the request and performs grant and delivery work around that
conditional update. Two concurrent admins could both observe `pending` and
produce side effects even though only one request transition wins.

The existing `ask_fallback_to_nonadmin` policy is delivery fallback, not
delegated governance. A non-admin human must not become an approver merely by
receiving an unanswered ask.

## Problem

Make concurrent human-admin decisions deterministic and auditable, while
preserving human-only administrative authority and avoiding an implicit
delegation model.

## Decision

1. Every live human admin receives governance requests. The first valid
   decision wins; later decisions receive a conflict that identifies the
   recorded decision-maker and settled result.
2. The pending-to-settled compare-and-set and every resulting state change
   occur in one SQLite transaction. For approval, this includes grant minting,
   request attribution, audit rows, and the claim delivery record. A losing
   admin produces no grant, Presence, or duplicate audit side effect.
3. `is_admin` remains the sole governance capability and stays human-only.
   This increment does not add delegated approval, role-based sub-admin
   authority, or a policy that promotes a non-admin fallback recipient.
4. At least one active human admin must remain. Disabling, banning, archiving,
   or removing the final admin is refused; a recovery procedure requires an
   existing administrator or an operator-owned break-glass path recorded in
   audit.

## Consequences

- Existing single-admin behavior is unchanged, but the approval outcome is
  stable when several admins act at once.
- Human Members who are not admins can still receive consultative fallback
  asks and steer work, but cannot issue grants, decide claims, or govern
  policy.
- Delegation remains a later, separately designed security increment after
  two-human dogfood establishes the real routing and accountability needs.
- No protocol schema change is required for the transactional core; an
  additive response field may expose the recorded decision-maker if the CLI
  and MCP need it.

## Observability & Evaluation

- Traces: `request.decide` records the winning human admin, decision, and
  request ID; a losing attempt records a non-secret conflict outcome.
- Eval: an integration test drives two human admin credentials against one
  pending request concurrently. Baseline: both routes can observe a pending
  request before settlement. The completed behavior has exactly one settled
  request, grant, delivery, and winning audit row.
- Experiment: two-human dogfood measures whether all-admin routing produces
  duplicate attention or slow decisions before any delegation policy is
  proposed.

## What survives the withdrawal — 2026-09-04

ADR 343 withdrew **decision 2** (the single-transaction requirement) and the duplicate-side-effect
inference that motivated it, having found the race unreachable on the current daemon; that finding
was re-verified on `1a5ec5ee` (see ADR 343 §Re-verification). **Decision 1** — first-valid-decision-
wins with a conflict naming the recorded decision-maker — is the behaviour the existing conditional
settlement already produces, so it is description, not a pending change.

Decisions **3** (`is_admin` is the sole governance capability and stays human-only, with no implicit
delegation via `ask_fallback_to_nonadmin`) and **4** (at least one active human admin must remain)
were never contested by ADR 343 and are not withdrawn here. They are restated by ADR 343 decision 2
as the standing posture until a two-human dogfood produces evidence.

This ADR remains readable as the record of the concern. It does not authorize the unimplemented
transactional behaviour, and a reader should not treat decision 2 as pending work.
