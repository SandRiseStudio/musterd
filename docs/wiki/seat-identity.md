# Seat identity — leaks, clobbers, and recovery

An identity swap has no failure mode — the seat resolves, tools work, you are just someone else — so diagnose with `claude mcp get musterd` (the adapter's env), never by reading `binding.json`, which can be correct while the adapter lies.

## The repo-root MCP leak (2026-07-13, ADR 143/#268; falsify: claude mcp get musterd per worktree)

Claude Code keys its local-scope MCP config by REPO ROOT, so every seat worktree of `/Users/nick/agents` shares ONE MCP entry. `musterd agent` used to write `MUSTERD_BINDING` into it, silently turning every live session on the machine into the same seat. Fixed two layers deep: `musterd agent` no longer writes the env at all (the adapter anchors on the binding found walking up from cwd), and the adapter refuses a cross-workspace `MUSTERD_BINDING` loudly. The same shared entry also once pointed every seat at a sibling's dirty stale dist (2026-08-04) — keep it on `/Users/nick/agents/packages/mcp/dist/index.js` (the daemon's own autorefreshed checkout) and the node path on `/opt/homebrew/opt/node@22/bin/node` (the keg's stable symlink; a patch-pinned Cellar path breaks on `brew upgrade`). Do not "just publish and npx" — the published adapter freezes while the daemon autorefreshes, and ADR 156 makes publishing a five-package lockstep release.

## The binding clobber (2026-07-09; falsify: diff sibling bindings after musterd agent)

`musterd agent <name>` once resolved its write target from ambient cwd and overwrote a sibling worktree's `binding.json` byte-identical (ADR 143 also guarded `resolveBindingDir`, the same hole from a second direction). After provisioning, diff the new worktree's binding against siblings — grants must differ (the grant is per-seat identity; agent_key is team-level and legitimately shared). Recovery for the clobbered seat: `musterd agent <seat> --path <workspace>` (idempotent, explicit path), run by an admin.

## Roles (ADR 227)

The route to un-mute or re-role a seat is `musterd role assign <seat> <role> [--remove]` run in the roster home (`/Users/nick/musterd/revive`) — the daemon reconciles the toml; never edit the DB. An `observer`-role seat has `can_message: none`, which presents as a muted seat.

## Recovery rules

- **The adapter caches its boot-time grant.** In-session repair never takes: after fixing a binding or an expired grant, a live session needs `/mcp` reload; `team_join` silently rejoins as the old seat until then.
- **`expired_grant` on `team_join`/`musterd claim`** (2026-07-15): re-mint from the seat's own workspace with `musterd agent <seat> --path <workspace>` — localhost admin trust. The CLI works immediately; the MCP tools lag until reload, so drive status/lane/inbox over the CLI meanwhile.
- **The CLI is the fallback channel** — it reads the worktree `binding.json` per invocation, so it stays the right seat when the MCP adapter is lying.
