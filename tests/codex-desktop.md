# Codex desktop verification matrix

This is the manual acceptance record for the Codex desktop Surface described by
[ADR 216](../docs/decisions/216-codex-cli-residency-backend.md). It verifies ordinary MCP
coordination and explicitly does not advertise desktop daemon wake. Run it in a trusted project
workspace with the musterd daemon already serving the target Team.

## Run metadata

| field                 | value                          |
| --------------------- | ------------------------------ |
| date                  | 2026-08-03                     |
| operator              | nick                           |
| Team                  | revive                         |
| workspace             | `/Users/nick/agents-gptbot`    |
| daemon                | `http://127.0.0.1:4849`        |
| Codex desktop version | record from the app under test |

## Matrix

For each row, record the observed evidence and set `pass` to `yes` or `no`. A `no` means the
failure interpretation applies; it is not permission to infer a stronger capability.

| check                     | procedure                                                                           | expected evidence                                                                                                                 | pass                      | failure interpretation                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| trusted project           | Open the enrolled workspace in Codex desktop.                                       | The project opens without a trust prompt that bypasses the project configuration.                                                 | pending                   | Project trust or configuration loading is unresolved; do not continue to wake claims.                |
| MCP load                  | Run `/mcp` and inspect the server list.                                             | `musterd` appears and is enabled.                                                                                                 | yes — observed 2026-08-03 | The global/project MCP configuration is not loaded by this Codex process.                            |
| explicit join             | Ask the session to call `team_join` for its assigned Member.                        | A new Presence appears for the expected Member and `codex` Surface.                                                               | pending                   | MCP is reachable but identity or binding is wrong; inspect the local binding and daemon Team.        |
| claim approval            | Complete any required claim/grant approval through the normal musterd flow.         | The Member becomes present without a second untracked identity.                                                                   | pending                   | Authorization or seat binding is not proven. Do not treat tool availability as occupancy.            |
| directed delivery         | Send a directed Act to the desktop Member from another Surface.                     | The Act appears in the desktop session's `team_inbox_check` result.                                                               | pending                   | Durable delivery or Member routing is broken. Check the daemon before retrying.                      |
| inbox drain               | Call `team_inbox_check` and acknowledge the delivered Act.                          | The Act is no longer unread on the next inbox check.                                                                              | pending                   | Cursor advancement or acknowledgement is not working.                                                |
| duplicate-seat protection | Start or reload a second Codex desktop session using the same agent seat.           | The existing agent Presence is protected by the normal newest-wins/superseded behavior; no parallel autonomous identity persists. | pending                   | Seat protection is unverified. Do not call this two-session behavior supported.                      |
| project isolation         | Open a different project without its musterd binding and inspect `/mcp`.            | The second project does not silently inherit the enrolled workspace's Member identity.                                            | pending                   | A credential or binding crossed workspace boundaries. Stop and rotate credentials if exposed.        |
| reload/reconnect          | Run `/mcp reload`, then call `team_status` and `team_inbox_check`.                  | The server reconnects, the expected Team remains selected, and the Member can continue after any normal rejoin.                   | yes — observed 2026-08-03 | The adapter process is stale or cannot reconnect; inspect the MCP target and daemon build stamps.    |
| model/build attestation   | Inspect `team_status` and the daemon roster after joining.                          | The expected model and build warning/attestation state is visible; a mismatch warns rather than silently claiming parity.         | pending                   | Runtime provenance is missing or stale. Rebuild/reload before accepting the result.                  |
| offline manual resume     | Stop the desktop session, send it a directed Act, then reopen the project manually. | The Act is available from the durable inbox after reopening; no daemon wake is claimed.                                           | pending                   | Durable inbox delivery is broken, or the test accidentally relies on unsupported desktop automation. |

## Capability boundary

Codex desktop is coordination-capable through its project MCP configuration. It is not a
daemon-wakeable residency backend. A manual app reopen, `/mcp reload`, or reconnect proves ordinary
coordination only; it does not prove exact task targeting, lifecycle observation, or safe wake/resume.
Desktop may be advertised as wakeable only after a versioned, supported API proves all three seams.

The Codex CLI backend is separate: its capability probe and owner-gated real acceptance test do not
upgrade the desktop Surface.
