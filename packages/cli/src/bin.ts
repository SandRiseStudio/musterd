#!/usr/bin/env node
import { parseArgs } from './args.js';
import { agentCommand } from './commands/agent.js';
import { auditCommand } from './commands/audit.js';
import { availabilityCommand } from './commands/availability.js';
import { claimCommand } from './commands/claim.js';
import { fmtCommand } from './commands/fmt.js';
import { reachabilityNudge } from './commands/helpers.js';
import { inboxCommand } from './commands/inbox.js';
import { initCommand } from './commands/init.js';
import { joinCommand } from './commands/join.js';
import { notifyCommand } from './commands/notify.js';
import { nudgeCommand } from './commands/nudge.js';
import { reclaimCommand } from './commands/reclaim.js';
import { reloadCommand } from './commands/reload.js';
import { requestsCommand } from './commands/requests.js';
import { resetCommand } from './commands/reset.js';
import { roleCommand } from './commands/role.js';
import { laneCommand, lanesCommand } from './commands/lane.js';
import { sendCommand } from './commands/send.js';
import { serveCommand } from './commands/serve.js';
import { serviceCommand } from './commands/service.js';
import { statusCommand } from './commands/status.js';
import { teamCommand } from './commands/team.js';
import { unbindCommand } from './commands/unbind.js';
import { uninstallCommand } from './commands/uninstall.js';
import { whoamiCommand } from './commands/whoami.js';
import { wireCommand } from './commands/wire.js';
import { CliError } from './errors.js';
import { renderBanner } from './render/rows.js';
import { theme } from './render/theme.js';
import { cliVersion } from './version.js';

const HELP = `${'musterd'} — muster your agents and humans into persistent teams

usage:
  musterd --version                             print the installed @musterd/cli version
  musterd init [--check]                        interactive first-run setup (recommended); --check reports provisioning drift without writing
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
  musterd lane open "<title>" [--surface <glob>,…] [--depends <id>,…] [--project p] [--branch b] [--claim]   declare a unit of work; warn-only contention checks (ADR 083)
  musterd lane <claim|handoff|update|resolve> <id> [--to <seat>] [--branch <ref>] [--state <s>]   own / transfer-with-branch / edit / close a lane
  musterd lanes [--project p] [--mine] [--open] [--json]   the lane board — who owns what, with live warnings
  musterd inbox [--watch] [--all] [--unread] [--peek] [--limit <n>] [--from <name>] [--act <act>]
  musterd inbox --wait [--timeout <seconds>] [--from <name>] [--act <act>] [--json]   block until the next directed act, then exit (pairs with /loop)
  musterd nudge                                 print directed acts waiting for this seat (read-only; the approval-prompt hook target)
  musterd whoami                                show the seat this folder resolves to (member, team, surface, source)
  musterd status
  musterd audit [--limit <n>] [--before <ms-epoch>] [--json]   read the governance audit log (admin-only, ADR 071/074)
  musterd availability <available|away|dnd> [--until <iso>]   set your availability (away holds notifications; dnd passes directed + urgent)
  musterd notify [--interval <seconds>] [--once]   background nudge: OS notification when a directed act lands while you're away
  musterd claim <name> [--token <code>] | --role <role> [--for <code>] [--surface <s>] [--force]   claim a seat (or adopt a teammate's seat with --token; --force repoints a folder bound to a live member); claiming a held seat opens a request and waits for an admin to approve
  musterd requests [--pending] [--json]         list claim/teammate requests (admin-only, ADR 077)
  musterd requests decide <id> --approve [--once | --standing | --ttl-hours <n>] | --deny   approve (grant lifetime: once=default, standing=until revoked, ttl=windowed) or deny a pending request (admin-only)
  musterd unbind                                release this folder's seat — keeps it on the team, free to re-claim (ADR 058)
  musterd reclaim <member>                      drop a member's stuck/stale live session so it can rejoin
  musterd fmt [--check]                         canonicalize this folder's .musterd/ roster files (ADR 058)
  musterd reload                                tell the running daemon to re-read the roster files (SIGHUP; after team export)
  musterd role list | show <name> | create <name> [--from <builtin>] [--force]   manage role provisioning templates (.musterd/roles/)
  musterd reset [--force] [--no-backup]         wipe the local db + identities back to a clean slate (daemon must be stopped)
  musterd uninstall [--force]                   remove what musterd added to this folder's harness (servers, permissions, primer)

global flags: --team <slug>  --server <url>  --json  --no-color  --quiet (suppress the reachability nudge)

acts: message status_update request_help handoff accept decline wait resolve  (accept/decline auto-target the latest open request unless you pass --reply-to)`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = parseArgs(argv.slice(1));

  // `--version`/`-v`/`version` print the CLI version and exit (ADR 067) — the first thing a fresh
  // agent reaches for. Checked before help so `musterd --version` isn't swallowed by the help path.
  if (
    command === 'version' ||
    command === '--version' ||
    command === '-v' ||
    rest.flags['version'] === true ||
    argv.some((a) => a === '--version' || a === '-v')
  ) {
    process.stdout.write(cliVersion() + '\n');
    return 0;
  }

  // `--help`/`-h` anywhere prints usage and exits — never runs the command (e.g. `notify --help`
  // must not launch the resident notifier).
  const wantsHelp =
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    rest.flags['help'] === true ||
    argv.slice(1).some((a) => a === '--help' || a === '-h');
  if (wantsHelp) {
    process.stdout.write(renderBanner() + '\n\n' + HELP + '\n');
    return 0;
  }

  const code = await dispatch(command, rest);
  // Agent-side reachability (ADR 046): append a one-line nudge to stderr when a directed act is
  // waiting for the acting member, so a heads-down agent that never runs `inbox` still sees it.
  // Best-effort — never fails the command, never touches stdout (keeps --json/pipes clean).
  const nudge = await reachabilityNudge(command, rest);
  if (nudge) process.stderr.write(nudge + '\n');
  return code;
}

async function dispatch(command: string, rest: ReturnType<typeof parseArgs>): Promise<number> {
  switch (command) {
    case 'init':
      return initCommand(rest);
    case 'agent':
      return agentCommand(rest);
    case 'audit':
      return auditCommand(rest);
    case 'serve':
      return serveCommand(rest);
    case 'service':
      return serviceCommand(rest);
    case 'team':
      return teamCommand(rest);
    case 'join':
      return joinCommand(rest);
    case 'send':
      return sendCommand(rest);
    case 'lane':
      return laneCommand(rest);
    case 'lanes':
      return lanesCommand(rest);
    case 'inbox':
      return inboxCommand(rest);
    case 'nudge':
      return nudgeCommand(rest);
    case 'whoami':
      return whoamiCommand(rest);
    case 'status':
      return statusCommand(rest);
    case 'availability':
      return availabilityCommand(rest);
    case 'notify':
      return notifyCommand(rest);
    case 'claim':
      return claimCommand(rest);
    case 'fmt':
      return fmtCommand(rest);
    case 'unbind':
      return unbindCommand(rest);
    case 'reload':
      return reloadCommand(rest);
    case 'reclaim':
      return reclaimCommand(rest);
    case 'requests':
      return requestsCommand(rest);
    case 'wire':
      return wireCommand(rest);
    case 'role':
      return roleCommand(rest);
    case 'reset':
      return resetCommand(rest);
    case 'uninstall':
      return uninstallCommand(rest);
    default:
      throw new CliError(`unknown command "${command}" — run: musterd help`, 2);
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof CliError) {
      process.stderr.write(`${theme.err('✗')} ${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`${theme.err('✗')} ${(err as Error).message}\n`);
    process.exit(1);
  });
