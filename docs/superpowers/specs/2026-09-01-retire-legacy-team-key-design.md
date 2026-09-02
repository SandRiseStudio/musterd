# Retire the legacy Team-wide bootstrap credential

## Goal

Remove the Team-wide `mskey_` compatibility path without interrupting existing agent Workspaces or
residency hosts. Every held agent seat and enrolled residency host moves to a scoped credential
before an administrator disables legacy acceptance for the Team.

## Current state

ADR 344 added seat-, role-, and host-scoped bootstrap credential records. Migration v52 copied each
existing `teams.agent_key_hash` into an active `legacy` record and kept both representations during
a compatibility window. New credential minting is scoped, but existing Workspaces still present the
legacy key.

The legacy key can authenticate a claim request for any agent seat in its Team. A grant or live
administrator decision still gates occupation, and routine agent HTTP already requires a seat
credential plus a Presence-bound lease. Retirement reduces bootstrap blast radius; it does not
replace those later authorization checks.

## Decision

Retirement has two explicit phases: migrate each required target, then cut over the Team.

### Agent Workspace migration

`musterd wire --migrate-bootstrap` migrates the current Workspace when its binding contains:

- an active legacy `agent_key`;
- a resolved agent seat claim; and
- that seat's existing `seat_credential` (`msac_`).

The client sends the legacy credential and seat credential to a dedicated authenticated HTTP
endpoint. The server derives the Team and seat from its own credential lookups. It does not trust a
client-declared seat, binding path, Workspace label, or harness name as authorization proof.

The server verifies that:

1. the bootstrap credential resolves to an active, unexpired `legacy` record for the Team;
2. the seat credential resolves to an active agent Member in the same Team; and
3. the Member is not disabled, banned, archived, or departed.

It then mints a `claim_seat` successor for that Member, marks it as migration-created, and returns
the plaintext once. The CLI atomically replaces `binding.agent_key` while preserving unrelated
binding fields. The operation creates no Presence, request, grant, or seat occupation.

The server audits predecessor credential ID, successor credential ID, target Member ID, and result.
No secret, hash, local path, Workspace label, or binding content enters logs, audit, telemetry, or an
error.

### Failed local write recovery

The server cannot re-return a successor after its plaintext response because it stores only the
hash. If the CLI cannot publish the updated binding, it reports that the legacy credential remains
valid and that rerunning the command is safe.

On retry, the server revokes any migration-created successor for that target that has never recorded
a successful scoped use, audits the cleanup, and mints a fresh successor. It never revokes a
successor after successful use. This prevents orphaned active credentials without storing plaintext.

### Residency host migration

A host has no independent pre-existing credential that can prove its label; the legacy key and a
client-declared host label are not sufficient proof. Hosts therefore do not self-migrate.

An administrator uses the existing scoped mint command:

```bash
musterd team bootstrap mint --host <label>
```

The administrator distributes the shown-once credential to that host's protected binding and
verifies a successful host-authenticated wake route. No new host migration endpoint is added.

### Readiness

`musterd team bootstrap cutover [--force] [--yes]` derives the required set from server-owned state:

- every active agent Member with `bound_at` set; and
- every active residency enrollment's host label.

A seat is ready only after a `claim_seat` credential for that Member records successful scoped claim
authentication. A host is ready only after a `host` credential for that label records successful
authentication on a residency wake, progress, turn, or report route. Minting alone does not count.

The command reports each unmet seat and host without exposing credential material. It refuses
cutover while any required target is unmet.

`--force` bypasses only this readiness refusal. It still requires an authenticated administrator,
records the unmet targets and authorizer in the audit log, and performs the same transactional
cutover. `--yes` bypasses the destructive confirmation for non-interactive operation; it does not
bypass readiness. A forced non-interactive cutover therefore requires both flags.

### Cutover

Successful cutover runs in one database transaction:

1. revoke every active `legacy` bootstrap credential for the Team;
2. clear `teams.agent_key_hash`; and
3. append the cutover audit record with whether readiness was complete or forced.

After cutover, legacy credentials fail before request creation, Presence attachment, or host work.
The refusal names the repair: an administrator must mint and distribute a seat-, role-, or
host-scoped bootstrap credential. Repeating cutover is a successful no-op that reports the Team is
already cut over.

The compatibility lookup code and v52 legacy-row support remain while any extant Team has an active
legacy record or non-null `agent_key_hash`. They are removed in a follow-up only after every Team has
recorded a successful cutover. Historical legacy rows and audit records remain for attribution.

## Interfaces

### Server

- One authenticated HTTP operation exchanges `legacy mskey_ + msac_` for a seat-scoped successor.
- Store helpers derive readiness, clean an unused migration successor, and execute transactional
  cutover.
- Existing claim and host authentication paths record successful scoped use by credential ID and
  target.
- Legacy refusal uses the existing authentication error vocabulary; no protocol frame or Envelope
  schema changes.

### CLI

- `musterd wire --migrate-bootstrap` performs one Workspace migration and atomic binding update.
- `musterd team bootstrap cutover [--force] [--yes]` previews readiness and performs the admin
  cutover.
- Existing `musterd team bootstrap mint --host` remains the host migration path.
- Help and human output state that secrets are shown once and that a failed local write leaves the
  legacy key usable for a safe retry.

### MCP

The MCP adapter receives no new tool. It reads the migrated binding on its next launch. A running
adapter continues under its occupied seat credential and Presence-bound lease; bootstrap credential
replacement does not interrupt that occupancy.

## Failure behavior

- Missing or non-legacy bootstrap credential: refuse without minting.
- Missing, invalid, cross-Team, human, disabled, banned, archived, or departed seat credential:
  refuse without minting.
- Binding publication failure: keep the legacy credential valid; retry revokes only an unused
  migration successor and returns a newly minted replacement.
- Missing scoped-use evidence: list unmet targets and refuse cutover.
- Forced cutover: require administrator authority and confirmation; audit the bypass and unmet set.
- Post-cutover legacy use: refuse with scoped-mint recovery guidance.
- Database failure during cutover: roll back legacy revocation, hash clearing, and audit together.

## Tests

### Store and transport

- A legacy credential plus a valid agent seat credential mints only that seat's successor.
- Cross-Team, wrong-kind, inactive-account, revoked, and expired inputs create no credential,
  request, grant, or Presence.
- Migration audit details contain IDs and result only; secrets and hashes never appear.
- Retry revokes an unused migration successor and mints a fresh one.
- Retry never revokes a successor with recorded scoped use.
- Required targets are exactly active held agent seats plus active residency hosts.
- Minted-but-unused credentials do not satisfy readiness; observed scoped use does.
- Cutover refuses with an exact unmet-target list.
- Complete and forced cutovers revoke legacy records and clear `agent_key_hash` atomically.
- Repeated cutover is idempotent.
- The old Team-wide key fails every claim and host route after cutover.

### CLI and end-to-end

- Workspace migration preserves every unrelated binding field and file mode.
- An injected atomic-write failure leaves the legacy key in the binding and prints safe retry
  guidance.
- Two agent Workspaces and one residency host migrate without dropping an existing Presence.
- After observed use and cutover, all three scoped credentials continue to work and the predecessor
  fails.

## Documentation and rollout

The implementation adds a retirement ADR and updates ADR 344's Consequences, `SPEC.md`, architecture,
the threat model, `SECURITY.md`, CLI help, and an operator migration runbook in the same change.

Rollout order:

1. ship migration, readiness, and cutover tooling while legacy acceptance remains enabled;
2. migrate each held agent Workspace;
3. mint and distribute each residency host credential;
4. observe scoped use for every required target;
5. run Team cutover;
6. verify legacy refusal and uninterrupted scoped operation; and
7. remove compatibility code only after every extant Team has cut over.

The live verification records target IDs and credential IDs only. It never records plaintext
credentials or local paths.
