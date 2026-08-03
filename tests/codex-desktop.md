# Codex desktop evidence matrix (ADR 204)

Run this manually after a Codex desktop upgrade. It verifies the desktop Surface; it does **not**
authorize daemon wake.

Record the tested Codex desktop version, OS, workspace path, and result for each row.

| Check | Procedure | Pass evidence |
| --- | --- | --- |
| Project MCP load | In an isolated workspace, run `musterd init` for Codex; reopen the workspace and inspect `/mcp`. | `musterd` is listed from that workspace's `.codex/config.toml`. |
| Reload/reconnect | Change only the project musterd entry, use the supported reload/reopen path, then reconnect. | The restored adapter joins the same Team and attests its current build/model. |
| Claim safety | Claim a named agent seat, then attempt a second live claim from another workspace. | First claim occupies; the duplicate is refused without displacing it. |
| Directed inbox | Send a directed Act while the desktop session is open; call `team_inbox_check`, then call it again. | The Act appears once and drains according to the normal inbox cursor. |
| Workspace isolation | Open a second workspace with a different binding. | Its adapter does not join or read the first workspace's Team. |
| Offline behavior | Close the desktop task, send a directed Act, then reopen manually. | The Act remains durable and is available after reconnect; no daemon wake is claimed. |

Desktop daemon wake stays **unsupported** unless a separately recorded, versioned probe proves a
stable supported API for exact task targeting, lifecycle observation, and safe resume. MCP reload
or successful manual reconnect is not that proof.
