# 344 — Scoped, rotatable agent bootstrap credentials

- Status: proposed
- Date: 2026-09-01

## Context

The current Team agent key (`mskey_`) authenticates an unoccupied agent
harness during the claim handshake. ADR 337 correctly prevents it from
authorizing routine HTTP: that requires the claimed agent seat's `msac_`
credential plus a Presence-bound `msls_` lease.

The bootstrap key is nevertheless one Team-wide secret, stored as
`teams.agent_key_hash`. Every workspace configured with that key can request
any agent seat. A live admin approval or grant still gates occupation, but the
key's compromise exposes every agent-seat claim request in the Team and
rotation replaces every configured agent at once.

A client-declared harness name cannot narrow this authority: the claimant
controls that declaration. A meaningful scope must instead be bound to the
secret record the server selects after hashing the presented key.

## Problem

Replace the Team-wide bootstrap secret with independently revocable,
least-privilege bootstrap credentials without widening their authority beyond
claim authentication or making key distribution unauditable.

## Decision

1. Replace the single `teams.agent_key_hash` with server-side agent bootstrap
   credential records. A record has an opaque ID, Team, SHA-256 key hash,
   allowed claim target (`seat:<name>` or `role:<name>`), optional
   administrator-facing Workspace/Harness label, state (`active`, `rotated`,
   or `revoked`), optional expiry, creator, and lifecycle timestamps. Labels
   are inventory only and never accepted from a client as authorization proof.
2. A bootstrap credential authenticates only a claim whose target matches its
   stored target. It remains bootstrap-only: it cannot authenticate routine
   Member HTTP, issue a grant, decide a request, alter policy, or choose a
   different seat/role. The existing grant, request, account-status, and
   single-active checks remain mandatory after this scope check.
3. Administrators mint a credential for one declared agent-seat target as the
   normal path. Role-target credentials are permitted only for an explicitly
   declared role pool and may claim only the server-selected open seat in that
   role. A credential is shown once, stored only in the target Workspace's
   protected binding, and never written into a committed launch spec.
4. Rotation is explicit and manual in this increment. An administrator mints
   a successor, distributes it to the intended Workspace, verifies a
   successful claim or a non-secret credential-use audit row, then revokes the
   predecessor. Scheduled and anomaly-triggered rotation are deferred until
   the future abuse-control increment supplies trustworthy signals and an
   operator response policy.
5. Credentials support an explicit expiry and revocation. Rotation does not
   automatically revoke the predecessor, permitting bounded staged migration;
   an administrator must select an expiry or revoke it after verification.
   Revoked and expired credentials fail closed before request creation or
   Presence attachment.
6. The existing Team `agent_key_hash` migrates to a marked legacy
   Team-scoped bootstrap record solely for a documented compatibility window.
   New minting never creates Team-scoped records. A release that removes the
   compatibility path must be separately ADR-gated after every configured
   Workspace has moved to a scoped credential.
7. The claim protocol keeps the opaque `mskey_` value as its input; the server
   identifies the matching stored record by hash. Additive record identifiers
   and lifecycle fields remain server-private unless an admin inventory
   response needs a redacted projection. No secret, raw hash, or Workspace
   path enters audit detail, logs, telemetry, HTTP responses, or diagnostics.

## Consequences

- A compromised scoped credential can initiate claims only for its assigned
  target and still cannot become routine agent authority under ADR 337.
- Rotating one agent no longer requires changing every other agent Workspace.
  The staged overlap is deliberate but creates temporary dual authority for
  one target, so the administrator must verify and revoke promptly.
- This requires an ADR-gated protocol and storage implementation: record
  migration, scoped authentication in HTTP and WebSocket claim paths, admin
  lifecycle operations, CLI/MCP binding migration, redaction, and coverage
  for target mismatch, expiry, revocation, rotation overlap, and legacy-client
  refusal after compatibility removal.
- Scheduled rotation, compromise detection, and automatic revocation are not
  implied by credential records. They remain dependent on the next
  claim-abuse-controls decision.

## Observability & Evaluation

- Traces: audit credential mint, use, target-mismatch refusal, expiry,
  rotation, and revocation by credential ID and target only. Diagnostics may
  report state and expiry, never a secret, hash, or local path.
- Eval: the server transport integration suite is the dataset. Its baseline
  accepts the current Team-wide key for any target; the completed behavior
  accepts a scoped credential only for its stored target, produces no request
  or Presence on mismatch, and keeps a valid `msac_` plus `msls_` requirement
  for every routine agent HTTP request.
- Experiment: migrate two disposable agent Workspaces one at a time, keeping
  one predecessor active only until successor claim evidence appears. Measure
  whether the inventory, recovery, and revocation instructions let an operator
  rotate one agent without interrupting the other.
