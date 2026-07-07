/**
 * The `musterd` CLI usage text. Extracted from `bin.ts` into its own module (ADR 085) so the guidance
 * drift check (`scripts/check-guidance.ts` / `pnpm guidance:check`) can import it *without* executing
 * the CLI entrypoint, and assert every command the skill names still exists here — a rename breaks the
 * build instead of rotting the skill.
 */
export const HELP = `${'musterd'} — muster your agents and humans into persistent teams

usage:
  musterd --version                             print the installed @musterd/cli version
  musterd init [--check [--fix]]                interactive first-run setup (recommended); --check reports provisioning drift without writing; add --fix to repair it by re-running init
  musterd wire [--autojoin] [--key mskey_…]     headless: register the MCP server from this folder's committed .musterd/workspace.json (self-wire a fresh clone; no prompts, no seat claim unless --autojoin)
  musterd serve [--port 4849] [--host 127.0.0.1] [--tls-cert <pem> --tls-key <pem> | --insecure-trust-proxy]
  musterd service <install|uninstall|start|stop|restart|status|logs> [--port <n>] [--host <h>] [--follow] [--force]   run the daemon as a background service (macOS LaunchAgent)
  musterd team create <slug> [--as <you>] [--role <role>] [--display <name>]
  musterd agent <name> [--role <role>] [--here | --path <dir>]   add an agent AND give it its own isolated workspace (git worktree) wired to run (ADR 065)
  musterd team add <name> --kind <agent|human> [--role <role>] [--lifecycle forever|session|until --until <iso>]
  musterd team remove <name>                    soft-remove a member from the roster (history is kept)
  musterd team export <slug>                     move a team's roster onto git-tracked .musterd/ files (ADR 058)
  musterd join <slug> --as <name> [--token <tok>] [--surface cli]
  musterd send --to <name|@team|@broadcast> --act <act> [--thread <id>] [--reply-to <id>] [--meta k=v] [--urgent --urgent-reason <why>] <body...>
                                                act = message|status_update|request_help|handoff|accept|decline|wait|resolve, or steering (ADR 102): steer (change direction, always interrupts, supersedes prior), challenge (justify-or-reconsider), defer (--meta goal_id=<id> [--meta wave=<n|later>] to reorder/defer a Goal)
  musterd lane open "<title>" [--surface <glob>,…] [--depends <id>,…] [--goal <id>] [--project p] [--branch b] [--claim]   declare a unit of work; warn-only contention checks (ADR 083); --goal links it to a Goal (ADR 084)
  musterd lane <claim|handoff|update|resolve> <id> [--to <seat>] [--branch <ref>] [--state <s>]   own / transfer-with-branch / edit / close a lane
  musterd lanes [--project p] [--mine] [--open] [--json]   the lane board — who owns what, with live warnings
  musterd next [--json]                         the orientation brief: what you're carrying, what to pick up, the next Goal, the latest handoff why (ADR 049/084)
  musterd done [<lane-id>] [--json]             close your work — mark the lane done (auto-targets your single live lane), then show what's next
  musterd goal declare "<title>" --goal-id <id> [--wave <n|later>] [--depends <id>,…]   declare a team Goal (lanes join it via --goal; status is derived) (ADR 048/084)
  musterd goal list [--json]                    the declared Goals with derived status (planned/in-flight/shipped)
  musterd report [--altitude ic|team|exec] [--json]   the insight report: flow metrics, waiting-on, Goal board — one derived projection (ADR 050/084)
  musterd report delivery [<id>]                       the delivery ledger (ADR 090): open directed acts and who has seen/answered them; with <id>, one act's per-recipient journey
  musterd report coordination                          coordination health (ADR 091): density, time-to-unblock, ignored help, stalled threads, circular handoffs
  musterd inbox [--watch] [--all] [--unread] [--peek] [--limit <n>] [--from <name>] [--act <act>]
  musterd inbox --wait [--timeout <seconds>] [--from <name>] [--act <act>] [--json]   block until the next directed act, then exit (pairs with /loop)
  musterd inbox --interrupt-check               silent unless an urgent directed act waits; then one daemon-composed line (the PostToolUse interrupt hook, ADR 088)
  musterd nudge                                 print directed acts waiting for this seat (read-only; the approval-prompt hook target)
  musterd whoami                                show the seat this folder resolves to (member, team, surface, source) — a bare \`musterd claim\` also confirms it when you're already seated
  musterd status
  musterd audit [--limit <n>] [--before <ms-epoch>] [--json]   read the governance audit log (admin-only, ADR 071/074)
  musterd availability <available|away|dnd> [--until <iso>]   set your availability (away holds notifications; dnd passes directed + urgent)
  musterd memory [show] | save --headline "<subject>" [body...] | clear   this seat's private continuity note (ADR 093): save before handing off / wrapping up; claim/status show the one-line pointer
  musterd notify [--interval <seconds>] [--once]   background nudge: OS notification when a directed act lands while you're away
  musterd claim [<name>] [--token <code>] | --role <role> [--for <code>] [--surface <s>] [--force]   get onto the team from this folder: bare \`claim\` occupies your bound seat (or confirms it if already live here), a name/role claims that seat, --token adopts a teammate's seat, --force repoints a folder bound to a live member; a held seat opens a request and blocks until an admin approves (then occupies — ADR 087)
  musterd requests [--pending] [--json]         list claim/teammate requests (admin-only, ADR 077)
  musterd requests decide <id> --approve [--once | --standing | --ttl-hours <n>] | --deny   approve (grant lifetime: ttl=default resume token/24h, once=single-use, standing=until revoked) or deny a pending request (admin-only)
  musterd unbind                                release this folder's seat — keeps it on the team, free to re-claim (ADR 058)
  musterd reclaim <member>                      drop a member's stuck/stale live session so it can rejoin
  musterd fmt [--check]                         canonicalize this folder's .musterd/ roster files (ADR 058)
  musterd reload                                tell the running daemon to re-read the roster files (SIGHUP; after team export)
  musterd role list | show <name> | create <name> [--from <builtin>] [--force]   manage role provisioning templates (.musterd/roles/)
  musterd reset [--force] [--no-backup]         wipe the local db + identities back to a clean slate (daemon must be stopped)
  musterd uninstall [--force]                   remove what musterd added to this folder's harness (servers, permissions, primer)

global flags: --team <slug>  --server <url>  --json  --no-color  --quiet (suppress the reachability nudge)

acts: message status_update request_help handoff accept decline wait resolve  (accept/decline auto-target the latest open request unless you pass --reply-to)`;
