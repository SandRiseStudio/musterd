#!/usr/bin/env node
import { startTelemetry, telemetryEnabled } from '@musterd/telemetry';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { parseArgs } from './args.js';
import { agentCommand } from './commands/agent.js';
import { auditCommand } from './commands/audit.js';
import { availabilityCommand } from './commands/availability.js';
import { claimCommand } from './commands/claim.js';
import { doneCommand } from './commands/done.js';
import { fmtCommand } from './commands/fmt.js';
import { goalCommand } from './commands/goal.js';
import { reachabilityNudge } from './commands/helpers.js';
import { inboxCommand } from './commands/inbox.js';
import { initCommand } from './commands/init.js';
import { joinCommand } from './commands/join.js';
import { laneCommand, lanesCommand } from './commands/lane.js';
import { memoryCommand } from './commands/memory.js';
import { nextCommand } from './commands/next.js';
import { notifyCommand } from './commands/notify.js';
import { nudgeCommand } from './commands/nudge.js';
import { reclaimCommand } from './commands/reclaim.js';
import { reloadCommand } from './commands/reload.js';
import { reportCommand } from './commands/report.js';
import { requestsCommand } from './commands/requests.js';
import { resetCommand } from './commands/reset.js';
import { roleCommand } from './commands/role.js';
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
import {
  nearestCommand,
  renderCommandHelp,
  renderGroupHelp,
  renderHelp,
  renderHelpJson,
} from './render/help.js';
import { setColorEnabled, theme } from './render/theme.js';
import { sym } from './render/ui.js';
import { cliVersion } from './version.js';

async function main(argv: string[]): Promise<number> {
  // Honor `--no-color` before any render. NO_COLOR / non-TTY are handled by picocolors' auto-detect;
  // this is the one place the flag is wired, and every command renders through the theme seam.
  if (argv.includes('--no-color')) setColorEnabled(false);

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
    // `help --json` → the machine-readable catalog (for agents/agentic workflows); `help <command>`
    // or `help <group>` → focused detail; otherwise the grouped overview (`--full` inlines the rest).
    if (rest.flags['json'] === true) {
      process.stdout.write(renderHelpJson() + '\n');
      return 0;
    }
    const topic = command === 'help' ? rest.positionals[0] : undefined;
    if (topic) {
      const detail = renderCommandHelp(topic) ?? renderGroupHelp(topic);
      if (detail) {
        process.stdout.write(detail + '\n');
        return 0;
      }
      // Unknown topic — fall through to the overview, but say what we couldn't find first.
      const near = nearestCommand(topic);
      process.stderr.write(
        `${theme.warn(sym.warn)} no command "${topic}"${near ? ` — did you mean "${near}"?` : ''}\n`,
      );
    }
    process.stdout.write(renderHelp({ full: rest.flags['full'] === true }) + '\n');
    return 0;
  }

  const code = await instrumentedDispatch(command, rest);
  // Agent-side reachability (ADR 046): append a one-line nudge to stderr when a directed act is
  // waiting for the acting member, so a heads-down agent that never runs `inbox` still sees it.
  // Best-effort — never fails the command, never touches stdout (keeps --json/pipes clean).
  const nudge = await reachabilityNudge(command, rest);
  if (nudge) process.stderr.write(nudge + '\n');
  return code;
}

/**
 * CLI telemetry (ADR 089): boot the shared SDK and run the command inside a `musterd.cli.command`
 * span — the command word only, never argv (bodies, tokens and paths live there). Off by default
 * (no OTLP endpoint → plain dispatch). Two carve-outs: `serve` (the daemon owns that process's
 * telemetry and its service name) and `inbox --interrupt-check` (the ADR 088 tool-boundary probe
 * has a sub-50ms budget an SDK boot would blow). Shutdown force-flushes with a hard cap — a
 * short-lived process must never hold its exit hostage to a dead collector.
 */
async function instrumentedDispatch(
  command: string,
  rest: ReturnType<typeof parseArgs>,
): Promise<number> {
  const skip =
    command === 'serve' || (command === 'inbox' && rest.flags['interrupt-check'] === true);
  if (skip || !telemetryEnabled()) return dispatch(command, rest);
  const telemetry = await startTelemetry({ serviceName: 'musterd-cli' });
  try {
    return await trace
      .getTracer('musterd-cli')
      .startActiveSpan('musterd.cli.command', async (span) => {
        span.setAttribute('musterd.command', command);
        try {
          const code = await dispatch(command, rest);
          span.setAttribute('musterd.exit_code', code);
          span.setStatus({ code: code === 0 ? SpanStatusCode.OK : SpanStatusCode.ERROR });
          return code;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          span.end();
        }
      });
  } finally {
    await telemetry.shutdown({ timeoutMs: 1000 });
  }
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
    case 'next':
      return nextCommand(rest);
    case 'done':
      return doneCommand(rest);
    case 'goal':
      return goalCommand(rest);
    case 'report':
      return reportCommand(rest);
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
    case 'memory':
      return memoryCommand(rest);
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
    default: {
      const near = nearestCommand(command);
      const suggestion = near ? ` — did you mean "${near}"?` : '';
      throw new CliError(`unknown command "${command}"${suggestion}  ·  musterd help`, 2);
    }
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof CliError) {
      process.stderr.write(`${theme.err('✗')} ${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`${theme.err(sym.err)} ${(err as Error).message}\n`);
    process.exit(1);
  });
