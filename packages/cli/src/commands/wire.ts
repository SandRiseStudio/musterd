import { type Binding, bindingSeat, type ClaimPolicy } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { findBinding, findWorkspaceSpec, loadConfig, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import { claudeCode } from '../onboard/harnesses/claudeCode.js';
import { buildMcpEnv, resolveMcpLaunch } from '../onboard/mcpEntry.js';
import { theme } from '../render/theme.js';

/**
 * `musterd wire` — the headless, no-prompt counterpart to `musterd init` for a folder that already
 * carries a **committed** `.musterd/workspace.json` (the secret-free launch spec, written by
 * `init`/`agent`). It reads that spec, resolves the team agent key from local sources (never the
 * committed file — the spec has no secret), and registers the musterd MCP server for this folder. This
 * is what lets a fresh clone/worktree self-wire without an interactive `init` (the ADR-060 non-goal,
 * unblocked by the committed spec).
 *
 * "Wire" = make the `team_*` tools available, NOT claim a seat: it does **not** set `MUSTERD_AUTOJOIN`
 * by default, so a shared repo cloned by many never has every clone auto-claim the same seat — the
 * session stays dormant until it joins explicitly (`team_join` / `musterd claim`). `--autojoin` opts a
 * personal worktree into claim-on-launch. The spec's `claim` policy still tells the adapter *which*
 * seat to occupy when it does join.
 */
export async function wireCommand(parsed: Parsed): Promise<number> {
  const flags = parsed.flags;
  const spec = findWorkspaceSpec(process.cwd());
  if (!spec) {
    throw new CliError(
      'no .musterd/workspace.json here — this folder has no committed musterd launch spec. ' +
        'Run `musterd init` to set it up (which writes the spec), or check you are in the right folder.',
      6,
    );
  }
  const config = loadConfig();
  const server = flagStr(flags, 'server') ?? spec.server;
  const team = spec.team;

  // Resolve the agent key locally — the whole point of the split: the key is NEVER in the committed
  // spec. Same precedence as `agent`/`init`: --key → env → this machine's global config.
  const agentKey =
    flagStr(flags, 'key') ?? process.env['MUSTERD_AGENT_KEY'] ?? config.agentKeys[team];
  const grant = flagStr(flags, 'grant') ?? process.env['MUSTERD_GRANT'];
  const autojoin = flags['autojoin'] === true;

  // Register tools only by default (no autojoin) — see the doc-comment above.
  const claim: ClaimPolicy = spec.claim ?? { mode: 'chat' };
  const agentBinding = {
    server,
    team,
    surface: spec.surface,
    claim,
    ...(agentKey !== undefined ? { agent_key: agentKey } : {}),
    ...(grant !== undefined ? { grant } : {}),
  };
  const launch = resolveMcpLaunch();
  const entry = {
    command: launch.command,
    args: launch.args,
    env: {
      ...buildMcpEnv(agentBinding),
      ...(autojoin ? { MUSTERD_AUTOJOIN: '1' } : {}),
    },
  };

  let mcpError: string | null = null;
  try {
    // `claude mcp add -s local` keys off cwd, which is already this folder — no chdir needed.
    await claudeCode.configure(entry, agentBinding);
  } catch (err) {
    mcpError = (err as Error).message;
  }

  // Materialize the gitignored binding.json (spec + resolved secrets) so subsequent CLI acts in this
  // folder resolve identity — mirrors `init`. A keyless binding is valid (a chat/human folder).
  // A re-wire must not forget what the seat attests: the model is a per-machine declaration that lives
  // only in the gitignored binding (never the committed spec), so re-deriving the binding from the spec
  // would drop it (ADR 101). Carry the existing declaration forward.
  const priorModel = findBinding()?.model;
  const binding: Binding = {
    server,
    team,
    surface: spec.surface,
    claim,
    ...(agentKey !== undefined ? { agent_key: agentKey } : {}),
    ...(grant !== undefined ? { grant } : {}),
    ...(priorModel !== undefined ? { model: priorModel } : {}),
  };
  saveBinding(process.cwd(), binding);

  const seat = bindingSeat(spec as Binding) ?? null;

  if (flags['json']) {
    process.stdout.write(
      JSON.stringify({
        team,
        member: seat,
        mcpRegistered: mcpError === null,
        keyResolved: agentKey !== undefined,
        autojoin,
      }) + '\n',
    );
    return 0;
  }

  if (mcpError === null) {
    process.stdout.write(
      `${theme.ok('✓')} wired the musterd MCP server for this folder ${theme.meta(`(team ${team})`)}\n`,
    );
    const target = seat ? `as ${theme.memberName(seat, 'agent')}` : `(assign a seat in chat)`;
    process.stdout.write(
      autojoin
        ? `${theme.dim(`this session will come online ${seat ? target : ''} automatically on launch.`)}\n`
        : `${theme.dim(`the team_* tools are available — join when ready (team_join / musterd claim ${seat ?? '<name>'}). Reload the session to pick up the tools.`)}\n`,
    );
  } else {
    process.stdout.write(
      `${theme.warn('⚠')} couldn't register the MCP server (${mcpError}). Register it here with:\n` +
        theme.meta(
          `  claude mcp add musterd -s local ` +
            Object.entries(entry.env)
              .map(([k, v]) => `-e ${k}=${v}`)
              .join(' ') +
            ` -- ${entry.command} ${entry.args.join(' ')}`,
        ) +
        '\n',
    );
  }
  if (agentKey === undefined) {
    process.stderr.write(
      theme.meta(
        `note: no team agent key on this machine (not in --key/MUSTERD_AGENT_KEY/global config for "${team}") — ` +
          `the tools are registered, but claiming a seat will need a key or admin approval. ` +
          `Set MUSTERD_AGENT_KEY, or ask a team admin for a grant.`,
      ) + '\n',
    );
  }
  return 0;
}
