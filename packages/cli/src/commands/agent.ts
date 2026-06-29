import type { Binding } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { loadConfig, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import { claudeCode } from '../onboard/harnesses/claudeCode.js';
import { buildMcpEnv, resolveMcpLaunch } from '../onboard/mcpEntry.js';
import { provisionWorkspace } from '../onboard/workspace.js';
import { theme } from '../render/theme.js';
import { writeSeatFile } from '../roster.js';
import { resolve } from './helpers.js';

/**
 * `musterd agent <name>` — one command to add an agent AND give it an isolated, ready-to-run
 * workspace (ADR 065). It (1) adds/revives the agent member on the team, (2) creates a git worktree
 * (own branch + tree) — a sibling folder outside git — (3) writes that folder's binding, and
 * (4) registers the musterd MCP server there with autojoin. Opening a Claude Code session in the
 * printed folder then *is* that agent, with no binding thrash against your own seat.
 *
 * `--here` keeps the legacy single-folder behavior; `--path <dir>` targets an explicit folder.
 */
export async function agentCommand(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[0];
  if (!name || /\s/.test(name)) {
    throw new CliError('usage: musterd agent <name> [--role <role>] [--here | --path <dir>]', 2);
  }
  const role = flagStr(parsed.flags, 'role');

  // Adding a member is an admin act — needs an active identity (binding/env/--as), like `team add`.
  const { team, http, config } = resolve(parsed.flags);

  // ADR 058 §5: write the seat file first for a file-backed team so the file stays the single writer;
  // db-only teams skip this and the daemon originates. addMember revives a soft-removed name (ADR 065).
  const home = loadConfig().rosterHome[team];
  if (home) writeSeatFile(home, name, { kind: 'agent', ...(role ? { role } : {}) });
  const res = await http.addMember(team, { name, kind: 'agent', ...(role ? { role } : {}) });
  const token = res.token as string;

  const here = Boolean(parsed.flags['here']);
  const ws = provisionWorkspace(name, {
    here,
    ...(flagStr(parsed.flags, 'path') ? { path: flagStr(parsed.flags, 'path')! } : {}),
  });

  const binding: Binding = {
    server: config.server,
    team,
    member: name,
    token,
    surface: 'claude-code',
    claim: { mode: 'seat', name },
  };
  saveBinding(ws.dir, binding);

  // Register the MCP server *for the workspace folder*: `claude mcp add -s local` keys off cwd, so we
  // run the adapter with cwd set to ws.dir. Autojoin so a session opened there comes online as `name`.
  const agentBinding = {
    server: config.server,
    team,
    member: name,
    token,
    surface: 'claude-code' as const,
  };
  const launch = resolveMcpLaunch();
  const entry = {
    command: launch.command,
    args: launch.args,
    env: { ...buildMcpEnv(agentBinding), MUSTERD_AUTOJOIN: '1' },
  };
  let mcpError: string | null = null;
  const prevCwd = process.cwd();
  try {
    process.chdir(ws.dir);
    await claudeCode.configure(entry, agentBinding);
  } catch (err) {
    mcpError = (err as Error).message;
  } finally {
    process.chdir(prevCwd);
  }

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        member: name,
        team,
        dir: ws.dir,
        kind: ws.kind,
        branch: ws.branch ?? null,
        mcpRegistered: mcpError === null,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(
    `${theme.ok('✓')} added ${theme.memberName(name, 'agent')} (agent${role ? `, ${role}` : ''}) to ${team}\n`,
  );
  const where =
    ws.kind === 'worktree'
      ? `git worktree on branch ${theme.accent(ws.branch ?? '')}`
      : ws.kind === 'folder'
        ? 'folder'
        : 'this folder';
  process.stdout.write(`${theme.ok('✓')} workspace: ${ws.dir} ${theme.meta(`(${where})`)}\n`);

  if (mcpError === null) {
    process.stdout.write(`${theme.ok('✓')} wired the musterd MCP server there (autojoin)\n`);
    process.stdout.write(
      theme.accent('→') +
        ` open a Claude Code session in ${ws.dir} — it joins as ${name} automatically\n`,
    );
  } else {
    // Member + workspace + binding are set up; only the harness wiring failed (e.g. no `claude` CLI).
    process.stdout.write(
      `${theme.warn('⚠')} couldn't auto-register the MCP server (${mcpError}). Register it in ${ws.dir} with:\n` +
        theme.meta(
          `  cd ${ws.dir} && claude mcp add musterd -s local -e MUSTERD_TEAM=${team} -e MUSTERD_MEMBER=${name} -e MUSTERD_TOKEN=${token} -e MUSTERD_SURFACE=claude-code -e MUSTERD_AUTOJOIN=1 -- ${entry.command} ${entry.args.join(' ')}`,
        ) +
        '\n',
    );
  }
  return 0;
}
