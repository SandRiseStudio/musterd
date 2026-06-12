# 012 — `musterd init` writes an agent primer (`AGENTS.md`)

- Status: accepted
- Date: 2026-06-12

## Context

The flagship 3-pane recording was attempted on 2026-06-12 and abandoned after 3 dead takes. The cause was not the script or the operator — it was that the agents **did not know how to use musterd**. A fresh Claude Code / Cursor agent, dropped into a session where the `team_*` MCP tools are *available*, doesn't know it's on a team, doesn't know to `team_join`, doesn't know to check its inbox at task boundaries, and improvises in plain chat instead of using the acts. This is the most important UX finding of the launch tail (`docs/implementation-plan.md` §4.A item 3) and is what a real first user would hit.

The tool *descriptions* are written for the agent, but a description is only read once the model is already calling that tool — nothing gives the agent **standing context at session start**.

## Problem

Where does an agent get standing, every-session context in a harness-native way? Reminders in tool results are too late and too narrow; a separate doc the agent must be told to read defeats the purpose. We need the agent to know the team working-loop *before* it acts.

## Decision

`musterd init` writes a **musterd primer into the binding folder's `AGENTS.md`** — the cross-tool agent-context file that both supported harnesses (Claude Code, Cursor) already read on every session. The primer states the agent's identity (member, team, role) and the working-loop: join at session start, check inbox at task boundaries, post `status_update`, `request_help` when blocked, `handoff`/`accept`/`decline` to move work, `team_status`/`team_members` to see who's around.

- Written to `<cwd>/AGENTS.md` (the same folder both harnesses are keyed to) after a successful `configure()`, behind a confirm (default yes); also offered on the manual-setup path.
- A **marker-delimited managed block** (`<!-- musterd:start -->`…`<!-- musterd:end -->`) makes it idempotent and non-destructive: re-running `init` updates only that block; the user's own `AGENTS.md` content is never touched.
- One file for both harnesses in v1; a `Harness.primerPath()` hook is the extension point if a future harness reads a different location.

Full spec: `docs/design/agent-primer.md`.

## Consequences

- Closes the onboarding gap at its root — agents get the working-loop as standing context, the harness-native way, with nothing to keep alive or reconnect at runtime. It is the prerequisite for retrying the real 3-pane recording (agents can carry the flow themselves).
- Init now writes a file into the user's working tree (like it already does for `.cursor/mcp.json`). Idempotent + confirmed + marker-scoped keeps that safe; the `secretPath` `.gitignore` nudge already set the precedent for "init touches the repo."
- A related, separately-scoped **collision guard** (warn when a member name is already bound in another folder, or a saved token no longer authenticates against a replaced db) belongs to the same finding and is specced alongside (`agent-primer.md` §7) but is lower priority than the primer itself.
- No protocol/server change; this is CLI-only. The `team_join` result copy and the `harness-hooks.md` Stop-hook remain complementary belts, not the primary mechanism.
