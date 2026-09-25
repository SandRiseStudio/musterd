# Workspace layout

Where every musterd folder on a machine lives, what is keyed by those paths, and how a machine is moved onto the layout.

## The layout (ADR 447; reach-and-boundaries spec §6 and ADR 442 for the rule beneath it)

| Folder | Example | Resolves to | Held by |
| --- | --- | --- | --- |
| Member Workspace | `~/musterd/<team>/<repo>/<member>` — `~/musterd/revive/agents/dolly`, `~/musterd/revive/agents/nick` | that member | a git worktree; humans and agents alike |
| Repo group | `~/musterd/<team>/<repo>` | nobody — refused by position | the member worktrees of one repo on one team |
| Team root | `~/musterd/<team>` (`~/musterd/revive`) | nobody — refused by position | the roof over one team's repo groups; on a file-backed team, the roster repo (`rosterHome`) |
| Service home | `~/.musterd/<service>` (`host`, `guardian`, `sweep`, `live`, `stream`, `autorefresh`) | the service's own seat token | LaunchAgents only |
| Runtime checkout | `~/.musterd/runtime` | **nobody** — unbound | the daemon's and host's build; `service refresh` self-locates it from the plist |
| Live publisher worktree | `~/.musterd/live/checkout` | nobody | the live service's own home (ADR 132, 2026-09-24) |

Identity resolves by walking **up** from the real path to the nearest `.musterd/binding.json` (lane 2, #1693). So `~`, `~/musterd`, `~/musterd/<team>` and `~/musterd/<team>/<repo>` never hold a binding — `bindingRefusal` (`onboard/guard.ts`) refuses them by position, even while empty, and refuses any folder with a Workspace up to two levels beneath it; `musterd init` / `human` always refuse, `claim` refuses a first binding. `musterd agent <name>` places a new seat at `~/musterd/<team>/<repo>/<name>` (`memberWorkspaceDir`, `onboard/workspace.ts`), where `<repo>` is the group the invoking Workspace already sits in when it is on the same team, else the remote's repo name, else the checkout basename. `musterd human <name>` places the person the same way (a worktree on `human/<name>`, their own git identity) when run inside a checkout, and needs `--home <dir>` outside one — the team root is never the floor.

Two teams on one repo are two trees: `~/musterd/revive/agents/dolly` and `~/musterd/other/agents/dolly` are two Members with two worktrees of the same repository. A project does **not** have to live under `~/musterd` — any folder with a binding is a Workspace; the layout is where the provisioning verbs put one by default.

## What is keyed by a Workspace path (inventory, measured 2026-09-24 on nick's laptop)

Each row is something a move has to carry, and the step of `scripts/layout/migrate.ts` that carries it.

| Path-keyed thing | Where | Carried by |
| --- | --- | --- |
| Git worktree parentage | every worktree's `.git` file names `<main>/.git/worktrees/<n>`; the main's `.git/worktrees/<n>/gitdir` names the worktree | step 3, `git worktree repair` from each moved worktree's own main checkout (read off its `.git` file) with the new paths |
| LaunchAgent plists (8) | `~/Library/LaunchAgents/studio.sandrise.musterd*.plist` — `ProgramArguments` and `WorkingDirectory` name the checkout | steps 1, 8: only a plist that names a moving folder is rewritten and bounced; the host is always bounced (it reads the registry once at start). Measured 2026-09-25: no plist names a member Workspace, so the daemon is not bounced |
| Bindings registry (ADR 020) | `~/.musterd/config.json` `bindings`, keyed by absolute folder; `teamHome[slug]` | step 4, re-keyed; a team root's entry is dropped and `teamHome` follows the human to their member Workspace |
| Team root binding (ADR 176) | `~/musterd/<team>/.musterd/binding.json` — the human's floor until ADR 447 | step 2, deleted (backed up); refused when the person has no member Workspace of that team |
| Residency workspaces | `~/.musterd/host-registry.json` `entries[].workspace` | step 4, rewritten — the host wakes a seat in its Workspace folder |
| Provisioning ledger | `~/.musterd/harness-ledger.json`, NUL-joined keys `folder\0<path>\0<harness>\0<slot>` | step 4, rewritten |
| Stream image, ad-hoc scripts | `~/.musterd/stream/image.json`, `cloud-seat/deploy-delta.sh`, `kill-repro.sh` | step 4, rewritten (any `~/.musterd` text file naming a moving folder) |
| Claude Code config | `~/.claude.json`: `projects` keyed by folder; `projects.*.mcpServers.musterd.args[0]`; `githubRepoPaths` | step 5, deep-rewritten (keys and values) |
| Claude Code transcripts + harness memory | `~/.claude/projects/<slug>` with slug = path with every non-alphanumeric → `-` | step 5, renamed (merged when the target exists) |
| Roster repo `.gitignore` | `~/musterd/<team>/.gitignore` | step 7, `/*/` + `!/.musterd/` appended so the member Workspaces beneath it stay out of `git status` in the roster repo |
| Seat binding files | `<workspace>/.musterd/binding.json` — no absolute paths of their own; `session.transcript_path` names a transcript under the old slug until the next session start | nothing — relative to the folder they move with |
| Per-folder harness files | `.mcp.json`, `.claude/settings.local.json`, `.grok/hooks/musterd.json`, `.musterd/workspace.json` — **and** `.codex/config.toml`, `.opencode/opencode.json`, `.cursor/mcp.json`, `.grok/config.toml`, whose `mcp_servers.musterd` names the adapter's `dist/index.js` by absolute path | step 6, rewritten when they name a moving folder. ~~0 absolute references (measured 2026-09-24)~~ — that measurement missed the four harness configs: after the 2026-09-24 move, 17 files across 10 seats still named `~/agents/packages/mcp/dist/index.js`, so Codex, OpenCode, Cursor and Grok sessions started from the new folders had no musterd tools (found 2026-09-25 when ghost and big-body restarted; repointed by hand at `~/.musterd/runtime`, backed up under `~/.musterd/backups/harness-paths-*`) |
| Codex session logs, Cursor workspace storage | `~/.codex/sessions/**` carry the cwd inside each JSONL; Cursor `.workspace-trusted` `workspacePath`; `~/.codex/config.toml` `hooks.state` keys | not migrated — history only; Codex re-asks to trust the hooks under the new path; Cursor transcripts recorded under the old path stop attributing to the seat after the move (`cursorCapture` matches by real Workspace root) |
| pnpm global `musterd` shim | `~/Library/pnpm/musterd` embeds `<runtime>/packages/cli/...` | nothing — the runtime does not move (re-link by hand if it ever does: AGENTS.md "Running the CLI from source") |
| The daemon's SQLite | `presences.workspace` is reported on each connect | nothing — refreshed by the next connect |

## Runbook — moving a machine

1. **Announce**: `team_send` that every seat session is about to drop. The run moves the folder every live session is standing in, including the runner's own — so it is run by the human, from `~`, in a plain terminal.
2. `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` (or any node ≥22 — the plists embed it; a Node 20 run would crashloop the daemon, AGENTS.md "TRAP").
3. `cd ~ && node --disable-warning=ExperimentalWarning ~/.musterd/runtime/scripts/layout/migrate.ts` — read the plan. It refuses when a team root is bound to a person who has no member Workspace of that team (stand them up first: `cd <checkout> && musterd human <name>`), or when run from inside a folder that moves.
4. Same command with `--apply`. Backups of every rewritten file land in `~/.musterd/backups/layout-<ts>/`. Idempotent: a source already gone with its target present is skipped, so an interrupted run is resumed by running it again.
5. Verify: `musterd whoami` from `~/musterd/<team>/<repo>/<member>` → that member, from `~/musterd/<team>` → not bound; `git -C ~/.musterd/runtime worktree list` (no `prunable`); `launchctl print gui/$UID/studio.sandrise.musterd-host | grep state`.
6. Re-open each seat session in its new folder; `claude --resume` finds its transcripts there because the project slug moved with it. Codex asks to trust its hooks again under the new path.

## Decided since

- ~~`~/.musterd/runtime-live` is where the sibling rule in `service.ts` puts the `/live` publisher's worktree (2026-09-24)~~ — same day: `service --live` now plants it at `~/.musterd/live/checkout`, the live service's own home, keeping an existing `<checkout>-live` sibling when one is present; the 2026-09-24 migration moved this machine's `~/agents-live` there.
- ~~The layout is `~/musterd/<repo>/<member>` and the team home `~/musterd/<team>` is a bound leaf (2026-09-24, ADR 442)~~ — 2026-09-25, ADR 447: team outermost, `~/musterd/<team>/<repo>/<member>`; the team root is an unbound roof. The 2026-09-24 move from `~/agents*` (reach spec lane 3, #1703) is done and its script replaced; the pnpm shim it re-linked pointed at the deleted `~/agents` until re-linked by hand the next day — the shim is keyed to the runtime, which this migration leaves alone.
