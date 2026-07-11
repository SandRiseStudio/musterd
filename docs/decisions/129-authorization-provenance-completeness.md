# 129 — Authorization provenance completeness (self-authorized admin verbs)

- Status: accepted
- Date: 2026-07-10
- Builds on: [ADR 127](127-authorization-provenance-gates.md) (`authorized_by` on decide/grant),
  [ADR 109](109-seat-git-attribution.md) (merge attestation), [ADR 071](071-v0.3-p2-in-band-enforcement-and-audit.md)
  (audit log)

## Context

ADR 127 closed the reserved `authorization-provenance` roadmap item by putting server-derived
`authorized_by` on `request.decide` / `grant.issue` and a read filter on the ledger. A follow-up
asked whether the remaining escalation / admin gates — especially `grant.revoke`, `member.reclaim`,
and `member.remove` — also need an `actor ≠ authorizer` join.

## Problem

Decide whether those verbs (and peer admin ops) are a provenance gap, or whether `actor` already
answers "who authorized it."

## Decision

**Provenance is complete. No code change.**

Audit of the live writers (`packages/server/src/transport/http.ts` and peers):

| Verb | Who writes `actor` | Separate authorizer? |
| ---- | ------------------ | -------------------- |
| `grant.revoke` | authenticated admin (`authAdmin`) | No — the admin who revokes _is_ the authorizer |
| `member.reclaim` | governance caller (`authGovernance`) | No — same; empty-admin fallback still records the caller who exercised the policy |
| `member.remove` | governance caller | No — same as reclaim |
| `key.rotate` / `policy.change` / `account_status.change` | authenticated admin | No — self-initiated admin ops |

`authorized_by` exists for the cases where **actor and authorizer can diverge** (or where a uniform
"who authorized this approval" key is load-bearing next to merges):

- `git.pr_merged` — resolving seat attests; human may differ (ADR 109).
- `request.decide` / `grant.issue` — same key as merges so `--authorized-by` answers one question
  across the approval surface (ADR 127). On those paths actor and authorizer coincide today, but the
  field is the stable join key.

Duplicating `authorized_by: <actor>` onto revoke/reclaim/remove would not add an attestable link; it
would only mirror `actor` for filter convenience. Readers who need "who did this admin op" already
filter on `actor`. Do not expand `--authorized-by` to mean "actor on self-ops."

## Consequences

- Roadmap item `authorization-provenance` stays shipped under ADR 127; this ADR is the completeness
  note, not a new reserved scope.
- Future gates that introduce a true actor≠authorizer path (e.g. an agent proposing a revoke that a
  human must approve) must add `authorized_by` in the same shape as ADR 127 — that would be a new
  ADR, not a silent extension here.

## Observability & Evaluation

**Traces** — n/a — no new emitters; the existing audit rows remain the observable.

**Eval** — **authorizer coverage** (ADR 127) unchanged: 100% of new `request.decide` / `grant.issue`
rows carry `detail.authorized_by`; self-authorized admin verbs continue to use `actor` as the
authorizer signal.

**Experiment** — none; dogfood already covers decide/grant via ADR 127. Spot-check: `musterd audit`
after a reclaim/remove shows `actor` = the admin who called the route, with no missing join.
