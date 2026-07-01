import type { Binding } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { loadConfig, saveBinding, saveWorkspaceSpec } from '../config.js';
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
  // Declare the seat (v0.3: no per-seat token — the agent claims it with the team agent key on launch).
  await http.addMember(team, { name, kind: 'agent', ...(role ? { role } : {}) });
  // The agent workspace authenticates with the team agent key (ADR 075), captured at `team create`.
  const agentKey = config.agentKeys[team] ?? process.env['MUSTERD_AGENT_KEY'];
  if (!agentKey) {
    throw new CliError(
      `no team agent key for "${team}" — create the team here (\`musterd team create ${team}\`, which ` +
        `captures it) or set MUSTERD_AGENT_KEY`,
      4,
    );
  }

  // Mint a standing grant for the seat so the workspace's autojoin occupies immediately on launch
  // instead of opening an admin-approval request every session (ADR 077). Best-effort: if it fails
  // (e.g. the caller isn't admin), the agent still comes online — its first claim just routes through
  // the approval lane. Issuing here is safe: `addMember` above already required an admin identity.
  let grant: string | undefined;
  try {
    const mint = await http.issueGrant(team, { scope: 'seat', target: name, lifetime: 'standing' });
    grant = mint.token;
  } catch {
    grant = undefined;
  }

  const here = Boolean(parsed.flags['here']);
  const ws = provisionWorkspace(name, {
    here,
    ...(flagStr(parsed.flags, 'path') ? { path: flagStr(parsed.flags, 'path')! } : {}),
  });

  const binding: Binding = {
    server: config.server,
    team,
    agent_key: agentKey,
    surface: 'claude-code',
    claim: { mode: 'seat', name },
    ...(grant !== undefined ? { grant } : {}),
  };
  saveBinding(ws.dir, binding);
  // Also write the secret-free committed launch spec (ADR: committed launch spec) so this worktree
  // self-wires via `musterd wire` on a fresh clone/machine — the key stays out of the committed file.
  saveWorkspaceSpec(ws.dir, {
    server: config.server,
    team,
    surface: 'claude-code',
    claim: { mode: 'seat', name },
  });

  // Register the MCP server *for the workspace folder*: `claude mcp add -s local` keys off cwd, so we
  // run the adapter with cwd set to ws.dir. Autojoin so a session opened there comes online as `name`.
  // The grant (if any) flows to MUSTERD_GRANT via buildMcpEnv so autojoin occupies without approval.
  const agentBinding = {
    server: config.server,
    team,
    agent_key: agentKey,
    surface: 'claude-code' as const,
    claim: { mode: 'seat', name } as const,
    ...(grant !== undefined ? { grant } : {}),
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
        granted: grant !== undefined,
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
          `  cd ${ws.dir} && claude mcp add musterd -s local ` +
            // Rebuild from entry.env so the manual command matches auto-register exactly — notably it
            // carries no MUSTERD_CLAIM (the seat lives in the binding.json this command already wrote,
            // the single source of truth), so the fallback can't reintroduce the re-claim drift.
            Object.entries(entry.env)
              .map(([k, v]) => `-e ${k}=${v}`)
              .join(' ') +
            ` -- ${entry.command} ${entry.args.join(' ')}`,
        ) +
        '\n',
    );
  }
  return 0;
}
