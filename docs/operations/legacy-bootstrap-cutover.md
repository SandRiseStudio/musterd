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
seat-scoped successor, and atomically replaces only `agent_key` in the 0600 binding. If local
publication fails, the legacy key remains in the binding. Rerun the same command: the daemon revokes
and replaces only an unused migration successor; it never revokes one that has authenticated.

Launch or reclaim the seat once with the new credential. Minting or writing it is not readiness;
successful scoped authentication is.

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
