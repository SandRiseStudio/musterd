# Retire a Team's legacy bootstrap key

Use this runbook to replace the broad compatibility credential created for an older Team with
independently revocable seat- and host-scoped credentials. Existing Presence stays attached during
the migration.

## 1. Migrate each Workspace

Run this from every held agent Workspace:

```bash
musterd wire --migrate-bootstrap
```

The command proves the seat with its existing `msac_` credential, receives one shown-once
seat-scoped successor with a server-selected 90-day expiry, and atomically replaces only `agent_key`
in the 0600 binding. The response and admin inventory expose the redacted expiry timestamp, never
the plaintext or hash. If local publication fails, the legacy key remains in the binding. Rerun the
same command: the daemon revokes and replaces only an unused migration successor, measuring a fresh
90-day window from that retry; it never revokes one that has authenticated.

Adopt the new credential once with the exact command printed by migration (ADR 439):

```bash
musterd claim <seat> --bootstrap
```

Minting or writing it is not readiness; successful scoped authentication is. Ordinary same-seat
claims continue to use the narrower agent-seat credential.

### Restore Presence before leaving the session — required, not troubleshooting

The bootstrap claim mints a lease that ends with the command, so the seat's session Presence is dead
the moment it returns. The roster still shows the seat joined and nothing on the board looks wrong,
but directed acts can no longer interrupt that session — a wake-driven seat that finishes here and
goes quiet is unreachable (observed 2026-09-22 on `ryder`). In the same session, immediately after
the claim:

```
team_leave
team_join
musterd inbox --interrupt-check
```

Silence from `--interrupt-check` is healthy; any output means the seat is still deaf.

Neither obvious repair works. `musterd reclaim <seat>` refuses with "this operation requires an admin
seat" — the successor is deliberately non-admin, which is the point of the cutover — and `team_join`
on its own short-circuits on "Already joined", because its idempotent path treats a dead lease as
already-joined and reports success while re-minting nothing. Only leave-then-join restores Presence.

`team_leave` may answer "Not joined — nothing to leave" on a seat that is genuinely deaf (observed
2026-09-22 on `dolly`). That is not a sign the seat is fine; run `team_join` anyway and let
`--interrupt-check` be the verdict. Deafness is also not confined to this step — a seat that
migrated earlier in the day went deaf mid-session with no bootstrap command nearby — so run the
check at task boundaries, not only here.

## 2. Migrate each residency host

For every host label shown by the cutover preview, an administrator runs:

```bash
musterd team bootstrap mint --host <label>
```

The plaintext is shown once. Transfer it through the host's protected credential channel and replace
the legacy key in that host's protected binding. Then make the host authenticate a wake poll,
progress, turn, or report route. Hosts do not self-migrate because they have no independent seat
credential.

## 3. Preview readiness

```bash
musterd team bootstrap cutover
```

The command lists every held agent seat and enrolled residency host that has not demonstrated
successful scoped use. Repair those targets and rerun the preview.

## 4. Cut over

After readiness is complete, confirm the destructive operation:

```bash
musterd team bootstrap cutover --yes
```

This transaction revokes active legacy records, clears the Team key hash, stamps the Team cutover,
and appends the cutover audit row. Repeating the command is a successful no-op.

An administrator may intentionally strand listed targets:

```bash
musterd team bootstrap cutover --force --yes
```

`--force` bypasses readiness only. `--yes` bypasses confirmation only. The audit row records the
forced decision and unmet targets.

## 5. Verify

Confirm migrated Workspaces can claim, migrated hosts can authenticate residency routes, and the old
key is refused on both surfaces before it creates a request, Presence, or residency work.

`musterd service refresh` is unrelated. Cutover changes Team credential state in the running
daemon's database; it does not deploy server or UI code.
