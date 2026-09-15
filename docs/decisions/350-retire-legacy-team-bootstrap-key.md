# 350 — Retire the legacy Team bootstrap key

- Status: accepted — 2026-09-01
- Date: 2026-09-01
- Lane: `01M1FPJ6JYRRWNF817AYFX94K1`

## Context

ADR 344 replaced new Team-wide bootstrap-key minting with independently revocable seat-, role-, and
residency-host-scoped credentials. Its storage migration retained each existing
`teams.agent_key_hash` as a marked `legacy` bootstrap credential so already configured agent
Workspaces and residency hosts did not stop working at deployment.

That compatibility path still lets one legacy `mskey_` authenticate a claim request for any agent
seat in its Team. A grant or live administrator decision remains necessary before occupation, and
routine agent HTTP requires the occupied seat's `msac_` plus a Presence-bound `msls_` lease under
ADR 337. The remaining risk is nevertheless broader than necessary: compromise of one configured
legacy key reaches every bootstrap claim target and every residency host route in the Team.

The daemon stores only credential hashes. A safe migration therefore cannot re-return a scoped
successor after its first response, and a residency host cannot prove its server-held label with the
legacy key plus a label it declared itself. Retirement needs explicit recovery and host migration
rules, not only a date when compatibility code disappears.

## Problem

Move every held agent seat and enrolled residency host to observed scoped bootstrap authority, then
let an administrator disable the legacy Team-wide credential without dropping an existing Presence,
orphaning shown-once credentials, trusting client-declared identity, or mistaking minting for
successful adoption.

## Decision

1. **Retirement is per Team and has migration then cutover phases.** Compatibility code remains in
   the product while any extant Team still has an active legacy record or non-null
   `teams.agent_key_hash`. Historical credential and audit rows remain after cutover.
2. **An agent Workspace self-migrates with two existing proofs.** A dedicated HTTP operation accepts
   an active legacy `mskey_` and an active agent-seat `msac_`. The server derives both Team and
   Member from its credential lookups, requires the same Team, and rejects human, disabled, banned,
   archived, or departed Members. A client-declared seat, role, host, Workspace label, path, or
   harness name is never authorization proof.
3. **The successor is restricted to the proven seat.** The server mints a `claim_seat` bootstrap
   credential targeted to that Member, marks it as migration-created for that Member, and returns
   its plaintext once. Migration creates no request, grant, Presence, or seat occupation. The CLI
   atomically replaces only the binding's `agent_key`, preserving unrelated fields and mode `0600`.
   A running adapter continues with its occupied seat credential and Presence-bound lease.
4. **A failed local publication is safely retryable.** The legacy credential remains valid until
   Team cutover. On retry, the server may revoke and replace only an active migration-created
   successor for the same target that has never recorded successful scoped use. Once scoped use is
   recorded, retry never revokes that credential and reports that the target has already migrated.
   No plaintext successor is stored or returned twice.
5. **Residency hosts do not self-migrate.** An administrator mints the existing `host`-scoped
   credential for the server-held host label, distributes its shown-once value to that host's
   protected binding, and verifies a host-authenticated wake, progress, turn, or report route. No
   legacy-key-plus-client-label exchange exists.
6. **Readiness comes from server-owned state and observed use.** Required seats are active agent
   Members with `bound_at` set. Required hosts are distinct labels on active residency enrollments.
   A seat is ready only when a matching `claim_seat` credential has successfully authenticated a
   scoped claim; a host is ready only when a matching `host` credential has successfully
   authenticated a residency route. Minting alone is not readiness evidence.
7. **Cutover is administrator-only and readiness-gated.** `musterd team bootstrap cutover` reports
   each unmet seat and host and refuses while any remain. `--force` bypasses only readiness and
   records the unmet targets and authorizer. `--yes` bypasses only destructive confirmation; forced
   non-interactive cutover therefore requires both flags.
8. **Cutover is one database transaction.** It revokes every active legacy credential for the Team,
   clears `teams.agent_key_hash`, records the Team cutover timestamp, and appends the cutover audit
   row together. Failure rolls back all four effects. Repeating a completed cutover is a successful
   no-op.
9. **Post-cutover legacy use fails before effects.** The old key cannot create a claim request,
   attach Presence, or create or advance residency work. Refusals direct the operator to
   administrator-minted seat-, role-, or host-scoped credentials.
10. **The boundary schemas are additive and the wire frame contract is unchanged.** New strict Zod
    schemas in `@musterd/protocol` parse migration and cutover HTTP bodies. No Envelope, Act, claim
    frame, or credential prefix changes.
11. **Evidence contains identifiers, never secrets.** Credential use records its first successful
    scoped-use timestamp. Migration and cutover audit details may contain predecessor and successor
    credential IDs, target Member IDs or host labels, result, readiness, force, and authorizer.
    Plaintext credentials, hashes, binding contents, local paths, and Workspace labels never enter
    logs, audit, telemetry, or errors.

## Consequences

- Each Team can remove its broad legacy bootstrap authority as soon as its own required targets
  demonstrate scoped use; product-wide compatibility removal does not block that security gain.
- Self-migration proves the seat with independently revocable routine authority instead of trusting
  metadata controlled by the claimant. Hosts require administrator custody because no equivalent
  independent proof exists.
- Failed binding publication may transiently leave one unused scoped successor in the daemon. The
  next retry cleans that exact unused migration successor without storing plaintext or endangering a
  credential that has worked.
- A forced cutover can intentionally strand an unmet Workspace or host. The command makes the unmet
  set explicit, requires administrator authority and confirmation, and preserves that decision in
  audit.
- Existing occupied sessions are not interrupted by bootstrap replacement. Bootstrap credentials
  authenticate future claims and host routes; routine occupied-seat authority remains `msac_` plus
  Presence-bound `msls_`.
- Removing legacy lookup and migration support is a later change gated on every extant Team
  recording successful cutover. This ADR authorizes per-Team retirement tooling, not premature
  deletion of compatibility code.

## Observability & Evaluation

- Traces: `bootstrap_credential.migrated` records predecessor ID, successor ID, target Member ID, and
  result; retry cleanup records the replaced credential ID; `bootstrap_credential.used` supplies
  first-use evidence; `bootstrap_credential.cutover` records readiness, force, unmet target IDs or
  labels, and authorizer. Every trace is credential-material-free.
- Eval: store and transport tests are the primary dataset. They must prove cross-Team, wrong-kind,
  inactive-account, revoked, and expired inputs have no claim, request, grant, Presence, or
  residency effects; minted-but-unused targets remain unmet; complete and forced cutovers are
  atomic and idempotent; and the legacy key fails every bootstrap route afterwards.
- Experiment: migrate two disposable agent Workspaces and one residency host while one agent
  Presence remains attached. Observe successful scoped use for all three, cut over, then verify all
  successors still work, the predecessor fails, and no credential material or local path appears in
  audit or diagnostics.
