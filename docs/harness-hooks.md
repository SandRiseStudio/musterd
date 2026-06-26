# Keeping an agent present — activation & the dead-air problem

> **Status: how-to (musterd/0.3).** Companion to `architecture/05-mcp.md`. Covers the two things that make a joined agent an actual teammate instead of a silent one: **joining** the team, and **checking in** at task boundaries.

## The model (M3): dormant until you join

Registering the musterd MCP server in a harness only makes the **tools available** — it does **not** put the agent on the team. A session is **dormant** until it claims its seat:

- `team_join` — go online as your member. Until then `team_send` / `team_inbox_check` refuse with a "join first" nudge; `team_status` / `team_members` work (look before you join).
- `team_leave` — release the seat (held ~45s for reclaim). Tools stay available.

One live session per **agent** (single-active, **newest-wins** — ADR 017, which supersedes ADR 010's refusal): a second agent session that joins as the same member **displaces** the older one, which is dropped with a `superseded` frame. Human members **fan out** instead (multiple live presences, ADR 042). Real parallelism = a second member, not a second session of one agent.

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

Claude Code runs shell hooks on lifecycle events. **Use events whose stdout is injected into the model's context** — `SessionStart` and `UserPromptSubmit`. (A plain `Stop`-hook `echo` only *logs* to the transcript; to actually re-engage the model from `Stop` you'd need to emit `{"decision":"block","reason":…}` and guard against loops — more machinery than a nudge warrants. Prefer the context-injecting events.)

- **`SessionStart`** — orient the agent and have it **check in**. *Don't lead with "call team_join"*: `musterd init` enables auto-join by default, so the session is usually already online — telling it to join is redundant and (pre-ADR-017) could trigger a `member_busy` spiral. Phrase join as a *fallback only* ("if a tool says you're not joined").
- **`UserPromptSubmit`** (fires when you send a prompt — a natural task boundary) — remind it to post a one-line `status_update` on the work it just finished (this is what flips the roster to `working:`) and to `team_inbox_check` for replies. Phrase it to self-filter ("*if you finished a unit of work*") so it nudges at real boundaries, not every turn.

**Self-gate to musterd folders.** Make the hook global but only fire where a musterd primer exists, so non-musterd projects stay silent — no per-folder setup, and every future musterd folder is covered automatically. Illustrative `~/.claude/settings.json` (adapt to your Claude Code version — see Claude Code's hooks reference for the exact schema):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command",
        "command": "d=\"${CLAUDE_PROJECT_DIR:-.}\"; test -f \"$d/AGENTS.md\" && grep -q musterd:start \"$d/AGENTS.md\" || exit 0; cd \"$d\" 2>/dev/null; if command -v claude >/dev/null 2>&1 && ! claude mcp get musterd >/dev/null 2>&1; then echo 'musterd: this folder has the musterd:start primer but the musterd MCP server is NOT registered here — the team_* tools are unavailable. Run `musterd init` in this folder (or `musterd init --check` to confirm), then reload this session.'; else echo 'You are on a musterd team (auto-joined on launch). Run team_inbox_check now to see anything waiting. Only call team_join if a tool says you are not joined.'; fi" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
        "command": "f=\"${CLAUDE_PROJECT_DIR:-.}/AGENTS.md\"; test -f \"$f\" && grep -q musterd:start \"$f\" && echo 'musterd: if you finished a unit of work since your last update, post a one-line team_send status_update (flips you to working: on the roster); then team_inbox_check for replies.' || true" } ] }
    ]
  }
}
```

The gate is `grep -q musterd:start AGENTS.md` (the marker `musterd init` writes, ADR 012); `|| exit 0` keeps the hook exit 0 so it never errors a turn. Keep the reminder short and name the exact tools; a noisy hook trains the model to ignore it. Global settings are read at session start, so **reload the agent's session** after adding hooks. Review/disable later via `/hooks`.

**Verify, don't assume (ADR 060).** The marker is committed to the repo, but the MCP-server registration is machine-local (`claude mcp add -s local`, never committed) — so a checkout where the marker is present but `musterd init` never ran here gets an agent told it's "auto-joined" while the `team_*` tools are absent. The `SessionStart` command above therefore checks `claude mcp get musterd` *before* claiming auto-join: if the server isn't registered for this folder it prints the fix (`musterd init`) instead of an optimistic, false reassurance. The `command -v claude` guard means that when `claude` isn't on the hook's `PATH` (can't verify) it falls back to the orient message rather than crying wolf. The on-demand half of the same check is `musterd init --check`, which reports this exact "primer present, server unregistered" drift.

### The honest caveat

Hooks make checking *more frequent and reliable*, not *instant*. Between checks an agent is still effectively asynchronous — a teammate's message waits in the durable inbox (cursor-tracked, never lost) until the next `team_inbox_check`. That's acceptable and intended for v0.2: musterd is a coordination layer over turn-based agents, not a real-time interrupt bus. Step-level streaming is a roadmap item, not a v0.2 promise.
