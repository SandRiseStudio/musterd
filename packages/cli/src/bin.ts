#!/usr/bin/env node
import { parseArgs } from './args.js';
import { availabilityCommand } from './commands/availability.js';
import { claimCommand } from './commands/claim.js';
import { inboxCommand } from './commands/inbox.js';
import { initCommand } from './commands/init.js';
import { joinCommand } from './commands/join.js';
import { notifyCommand } from './commands/notify.js';
import { reclaimCommand } from './commands/reclaim.js';
import { resetCommand } from './commands/reset.js';
import { roleCommand } from './commands/role.js';
import { sendCommand } from './commands/send.js';
import { serveCommand } from './commands/serve.js';
import { statusCommand } from './commands/status.js';
import { teamCommand } from './commands/team.js';
import { uninstallCommand } from './commands/uninstall.js';
import { CliError } from './errors.js';
import { renderBanner } from './render/rows.js';
import { theme } from './render/theme.js';

const HELP = `${'musterd'} — muster your agents and humans into persistent teams

usage:
  musterd init                                  interactive first-run setup (recommended)
  musterd serve [--port 4849] [--host 127.0.0.1] [--tls-cert <pem> --tls-key <pem> | --insecure-trust-proxy]
  musterd team create <slug> [--as <you>] [--role <role>] [--display <name>]
  musterd team add <name> --kind <agent|human> [--role <role>] [--lifecycle forever|session|until --until <iso>]
  musterd team remove <name>                    soft-remove a member from the roster (history is kept)
  musterd join <slug> --as <name> [--token <tok>] [--surface cli]
  musterd send --to <name|@team|@broadcast> --act <act> [--thread <id>] [--reply-to <id>] [--meta k=v] [--urgent --urgent-reason <why>] <body...>
  musterd inbox [--watch] [--unread] [--peek] [--limit <n>]
  musterd status
  musterd availability <available|away|dnd> [--until <iso>]   set your availability (away holds notifications; dnd passes directed + urgent)
  musterd notify [--interval <seconds>] [--once]   background nudge: OS notification when a directed act lands while you're away
  musterd claim <name> | --role <role> [--for <code>] [--surface <s>]   claim a seat for this folder (claim-on-first-use)
  musterd reclaim <member>                      drop a member's stuck/stale live session so it can rejoin
  musterd role list | show <name> | create <name> [--from <builtin>] [--force]   manage role provisioning templates (.musterd/roles/)
  musterd reset [--force] [--no-backup]         wipe the local db + identities back to a clean slate (daemon must be stopped)
  musterd uninstall [--force]                   remove what musterd added to this folder's harness (servers, permissions, primer)

global flags: --team <slug>  --server <url>  --json  --no-color

acts: message status_update request_help handoff accept decline wait`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = parseArgs(argv.slice(1));

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

  switch (command) {
    case 'init':
      return initCommand(rest);
    case 'serve':
      return serveCommand(rest);
    case 'team':
      return teamCommand(rest);
    case 'join':
      return joinCommand(rest);
    case 'send':
      return sendCommand(rest);
    case 'inbox':
      return inboxCommand(rest);
    case 'status':
      return statusCommand(rest);
    case 'availability':
      return availabilityCommand(rest);
    case 'notify':
      return notifyCommand(rest);
    case 'claim':
      return claimCommand(rest);
    case 'reclaim':
      return reclaimCommand(rest);
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
