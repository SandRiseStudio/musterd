# 440 — Bootstrap migration credentials inherit the seat-credential lifetime

- Status: proposed
- Date: 2026-09-22
- Lane: `01M351S3M0J6YVM16R93X48VZT`

## Context

ADR 403 requires a scoped credential minted for an agent seat to expire after 90 days by default.
ADR 350's Workspace migration path exchanges the legacy Team bootstrap key plus the Member's
independent agent-seat credential for a seat-scoped successor, writes it directly into the
Workspace's protected binding, and requires one successful scoped claim before cutover readiness.

The live `revive` migration exposed the stored result: every successor created by
`musterd wire --migrate-bootstrap` had `expires_at: null`. The server store hard-coded that value,
while cutover readiness deliberately treats an unexpired credential with a null expiry as valid.

## Problem

The supported, secret-safe migration path can make every Workspace cutover-ready while leaving
every migrated credential valid forever. The cutover gate therefore proves scoped use but cannot
prove ADR 403's bounded lifetime. Following the runbook exactly would pass the mechanism and fail
the security outcome it exists to deliver.

Requiring an administrator to mint and manually install one shown-once secret per Workspace would
discard the safer self-migration path and enlarge the opportunity for secrets to enter terminals,
clipboards, or transcripts.

## Decision

1. A migration-created `claim_seat` successor expires exactly 90 days after its server-side
   creation time. The server computes the timestamp; no client supplies or chooses it.
2. A retry that replaces an unused migration successor receives a fresh 90-day lifetime from the
   retry time. The existing rule remains: a successor with recorded scoped use is never replaced by
   migration.
3. Cutover readiness remains based on active, unexpired, successfully used scoped credentials.
   Its query does not gain a separate non-null-expiry clause because the migration constructor now
   establishes that invariant and explicitly non-expiring administrator-minted credentials remain
   a supported policy choice.
4. The migration request and response schemas do not change. The response's existing
   `expires_at` field exposes the server-selected deadline, and the CLI continues to keep the
   plaintext credential out of output.
5. Existing used migration credentials whose expiry is null are not silently rewritten. They must
   be rotated through the existing administrator lifecycle after a successor is installed and
   proven, preserving the no-surprise rule for already-issued authority.

## Consequences

- The normal Workspace migration path satisfies both ADR 350's observed-use gate and ADR 403's
  bounded seat-credential lifetime without a human handling plaintext.
- A failed local binding publication can safely retry: only the unused successor is revoked and
  the replacement gets a full new 90-day window.
- The already-used `big-body` successor discovered during the live migration needs one explicit
  staged administrator rotation; this decision does not mutate it behind the holder's back.
- No protocol version, database migration, runtime dependency, or CLI output shape changes.

## Observability & Evaluation

- Traces: the existing redacted migration response and admin inventory expose `expires_at`; no
  plaintext or hash is logged or audited.
- Eval: the dataset is the server store's first-migration and retry fixtures; the baseline returned
  `expires_at: null`. The tests fix `now` and assert the returned and persisted successor expiry is
  exactly `now + 90 days`, including a replacement measured from the retry time.
- Experiment: migrate one live Workspace, read its redacted inventory row, and compare
  `expires_at - created_at` with 90 days. If the value is null or differs, this decision is not
  implemented.

Follows-up: `01M2NR6BQCBJD8504J0J8S44MW`
