# 116 — `musterd agent --harness`: provision the agent workspace for any harness

- Status: accepted — 2026-07-08
- Date: 2026-07-08

## Context

`musterd agent <name>` (ADR 065) is the flagship one-command flow: add the member, cut a git worktree,
write its binding, and wire the musterd MCP server there with autojoin. But it **hardcoded Claude
Code** — `surface: 'claude-code'` in three places and a direct `claudeCode.configure(...)` call. A
Cursor or Codex user who ran it got a worktree that *looked* wired (the success line even said "wired
the musterd MCP server there"), but their harness had **nothing**: no `.cursor/mcp.json` /
`.codex/config.toml`, so the session came up unable to reach the team ("Currently offline"). Found
live: `musterd agent ryder` then opening the worktree in Cursor.

The capability already existed — a pluggable `Harness` registry (`HARNESSES`, ADR 038/085) with
`claude-code` / `cursor` / `codex` adapters, each knowing its surface and how to write its own MCP
config — but only `musterd init` used it. `musterd agent` didn't.

## Decision

Route `musterd agent`'s wiring through the **same harness registry `init` uses**, selected by a new
flag.

1. **`--harness <id>`**, default `claude-code` (back-compat). Resolved against `HARNESSES`; an unknown
   id fails fast listing the valid set, instead of silently no-op'ing.
2. **The harness drives the surface.** `binding.surface`, the committed `workspace.json` surface, and
   the attach surface all come from `harness.surface` — so the seat's presence attributes correctly
   (`cursor` / `codex`), not always `claude-code`.
3. **The harness writes its own MCP config** via `harness.configure(entry, binding)` — `claude mcp add
   -s local` for Claude Code, `.cursor/mcp.json` for Cursor, `.codex/config.toml` for Codex — with the
   command chdir'd into the worktree so each writes project-local.
4. **The MCP entry references the binding, never inlines secrets.** The env is
   `{ MUSTERD_BINDING: <worktree>/.musterd/binding.json, MUSTERD_SURFACE: <surface>, MUSTERD_AUTOJOIN: 1 }`
   — pointing the adapter at the gitignored `binding.json` (which already holds the agent key + grant)
   by absolute path. This changed the prior Claude-Code behaviour, which inlined the key/grant into the
   `claude mcp` env. Rationale:
   - **No secret is baked into any harness config** — critical for Cursor/Codex, whose configs live
     *in the worktree* (a committable file); the Claude-Code case (config in `~/.claude.json`, outside
     the tree) is no worse.
   - `binding.json` stays the **single source of truth** (ADR 018) — the same direction ADR 115 took
     (anchor writes to the binding, not ambient state). An absolute `MUSTERD_BINDING` also makes ADR
     115's `bindingDir` exact, independent of the adapter's cwd, so the two changes reinforce.

## Consequences

- **A Cursor or Codex agent is a first-class one-command setup.** `musterd agent ryder --harness
  cursor` produces a genuinely wired worktree; opening it in Cursor comes online as `ryder`.
- **Correct surface attribution** per harness on the roster and in audit.
- **No harness config carries a secret** — the in-tree Cursor/Codex files are commit-safe by
  construction (nothing to `.gitignore` for secrecy).
- The success/fallback messages are harness-aware (`open a <label> session…`; on a wiring failure,
  point at `musterd init` in the folder, which re-runs the same adapter — the binding is already
  written).
- **Back-compat:** omitting `--harness` is byte-for-byte the old Claude-Code flow except for the entry
  env shape (binding-reference instead of inlined key/grant) — a strict improvement.

## Observability & Evaluation

**Traces** — a provisioned worktree's `.musterd/binding.json` + the harness config file it wrote
(`.cursor/mcp.json` / `.codex/config.toml` / the `claude mcp` local entry) are the artifacts; the
seat's first `claim.occupied` audit row carries the attributed `surface`. `n/a` for `@musterd/telemetry`
OTel spans — this is a client-side provisioning command, not a server code path.

**Eval** — the metric is **harness-coverage of `musterd agent`** (which harnesses produce a working
wired workspace) and **falsely-"wired" provisions** (a success message with no harness config written).
*Dataset:* the provisioned worktree's config files + the seat's presence surface on first join.
*Baseline:* this session — Claude Code worked, Cursor/Codex silently produced an unwired worktree
(one live "Currently offline" Cursor agent). *Target:* all three harnesses produce a working wired
workspace; zero falsely-"wired" provisions.

**Experiment** — before/after is the same command per harness: `musterd agent <seat> --harness <h>`
then open that harness in the worktree and confirm it joins as `<seat>`. *Before:* only `claude-code`
joined; `cursor`/`codex` were offline. *After:* all three join — covered by unit tests asserting the
surface + entry per harness, and the flag validated end-to-end against the built CLI.
