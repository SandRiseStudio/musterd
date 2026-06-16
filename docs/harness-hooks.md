# Keeping an agent present — activation & the dead-air problem

> **Status: how-to (v0.2 / M3).** Companion to `architecture/05-mcp.md`. Covers the two things that make a joined agent an actual teammate instead of a silent one: **joining** the team, and **checking in** at task boundaries.

## The model (M3): dormant until you join

Registering the musterd MCP server in a harness only makes the **tools available** — it does **not** put the agent on the team. A session is **dormant** until it claims its seat:

- `team_join` — go online as your member. Until then `team_send` / `team_inbox_check` refuse with a "join first" nudge; `team_status` / `team_members` work (look before you join).
- `team_leave` — release the seat (held ~45s for reclaim). Tools stay available.

One member, one live session (single-active, ADR 010): a second session that joins as the same member is **refused** (`member_busy`) and stays dormant. Real parallelism = a second member, not a second session of one.

## Two ways to join

**1. Opt-in auto-join — `MUSTERD_AUTOJOIN=1`.** Set in the MCP server's `env` and the session joins on launch. `musterd init` offers this (recommended for the common solo case). Manual:

```bash
claude mcp add musterd -s local \
  -e MUSTERD_SERVER=http://localhost:4849 -e MUSTERD_TEAM=dawn \
  -e MUSTERD_MEMBER=Ada -e MUSTERD_TOKEN=<tok> -e MUSTERD_SURFACE=claude-code \
  -e MUSTERD_AUTOJOIN=1 \
  -- <musterd-mcp launch command>
```

**2. Explicit — just say so.** Without auto-join, tell the agent "join the musterd team" (it calls `team_join`), or wire a `SessionStart` hook (below). Explicit is the right default for shared teams, where silently occupying a seat isn't something a session should do on its own.

## The dead-air problem

A joined agent that goes heads-down won't see a teammate's message until it **calls `team_inbox_check`** — there's no interrupt that injects a message mid-turn. The same heads-down problem hides the agent's *own* progress: it shows as `online` (idle) on the roster until it posts a `team_send {act:'status_update'}`, which a focused agent rarely volunteers (the primer asks, but copy alone is unreliable). The durable fix for both is a **harness hook** that injects the reminder mechanically at task boundaries.

### Claude Code hook pattern

Claude Code runs shell hooks on lifecycle events; a hook's stdout can be fed back to the agent as context. Two useful events:

- **`SessionStart`** — emit a reminder to join + check in at the top of the session.
- **`Stop`** (the agent is about to finish its turn) — remind it to post a one-line `status_update` on what it just did (this is what flips the roster to `working:`) **and** `team_inbox_check` before going idle, so progress is visible and replies that arrived while it worked get picked up.

Illustrative `~/.claude/settings.json` (adapt to your Claude Code version — see Claude Code's hooks reference for the exact schema and output keys):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command",
        "command": "echo 'You are on a musterd team. Call team_join now, then team_inbox_check.'" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "echo 'Before finishing: post a one-line team_send status_update on what you just did, then call team_inbox_check — a teammate may be waiting on you.'" } ] }
    ]
  }
}
```

The reminder text is deliberately imperative and names the exact tools. Keep it short; a noisy hook trains the model to ignore it.

### The honest caveat

Hooks make checking *more frequent and reliable*, not *instant*. Between checks an agent is still effectively asynchronous — a teammate's message waits in the durable inbox (cursor-tracked, never lost) until the next `team_inbox_check`. That's acceptable and intended for v0.2: musterd is a coordination layer over turn-based agents, not a real-time interrupt bus. Step-level streaming is a roadmap item, not a v0.2 promise.
