# 127 — Authorization provenance on decide/grant gates

- Status: accepted
- Date: 2026-07-10
- Builds on: [ADR 109](109-seat-git-attribution.md) (merge `authorized_by`), [ADR 071](071-v03-p2-enforcement-audit.md)
  (audit log), [ADR 076](076-v03-p3-1-grants-keys-policy.md) (grant.issue), [ADR 077](077-v03-p3-2-claim-handshake.md)
  (request.decide)

## Context

ADR 109 put `authorized_by` on `git.pr_merged` so a landed SHA joins back to the authorizing human.
`request.decide` and `grant.issue` already record the deciding/issuing admin as `actor`, but:

1. The detail blob does **not** carry the same `authorized_by` key — grepping the trail for "who
   authorized this" has to special-case verbs.
2. An approve that **mints** a grant writes only `request.decide`; the grant itself leaves no
   `grant.issue` row, so the grant→authorizer join is missing.
3. There is no read filter for "show me everything this human authorized."

## Problem

Extend ADR 109's attestable authorizer link to the decide/grant gates — same key, server-derived
where the daemon already knows the human — and give admins a way to query by authorizer.

## Decision

### 1. `authorized_by` on decide/grant audit detail (server-derived)

Every `request.decide` and `grant.issue` audit row's `detail` includes
`authorized_by: <admin seat name>` copied from the authenticated admin (`actor`). No client override:
unlike merge attestation (the seat reports; the daemon cannot see GitHub), here the daemon _is_ the
authority that authenticated the admin, so the field is server-truth, not an attested claim.

### 2. Approve-minted grants also write `grant.issue`

When `POST …/requests/:id/decide` approves and calls `issueGrant`, append a `grant.issue` row (with
`authorized_by`) in addition to `request.decide`. The grant id / scope / lifetime ride the detail
alongside the authorizer — the same shape as `POST /grants`.

### 3. Read surface: `musterd audit --authorized-by <seat>`

`GET /teams/:slug/audit` accepts `?authorized_by=<seat>`: keep rows whose `detail.authorized_by`
equals that seat (also matches legacy `git.pr_merged` rows). The CLI passes the flag through; `--json`
unchanged. MCP read deferred — admins already use the CLI for the ledger; agents attest on
`lane_resolve`.

## Consequences

- One key (`authorized_by`) answers "who authorized it" across merges, decides, and grants.
- Approve→grant is fully auditable as two rows sharing the same authorizer.
- Roadmap item `authorization-provenance` ships this remaining reserved scope (beyond merges).

## Observability & Evaluation

**Traces** — the audit rows _are_ the observable (ADR 071/109 posture); no new emitters beyond the
approve-path `grant.issue` row.

**Eval** — **authorizer coverage**: fraction of `request.decide` / `grant.issue` / `git.pr_merged`
rows carrying `detail.authorized_by`. _Baseline:_ only `git.pr_merged` (when the client passed it).
_Target:_ 100% of new decide/grant rows; merges remain client-attested.

**Experiment** — dogfood: approve a claim request, `musterd audit --authorized-by <admin>` shows both
the decide and the minted grant; issue a standing grant via CLI and confirm the same filter.
