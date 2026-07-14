import { join } from 'node:path';
import { type Binding, resolveAttestedModel } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { loadConfig, saveBinding, saveWorkspaceSpec } from '../config.js';
import { CliError } from '../errors.js';
import { HARNESSES } from '../onboard/harnesses/index.js';
import { resolveMcpLaunch } from '../onboard/mcpEntry.js';
import { provisionWorkspace } from '../onboard/workspace.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import { writeSeatFile } from '../roster.js';
import { resolve } from './helpers.js';

/**
 * `musterd agent <name>` — one command to add an agent AND give it an isolated, ready-to-run
 * workspace (ADR 065). It (1) adds/revives the agent member on the team, (2) creates a git worktree
 * (own branch + tree) — a sibling folder outside git — (3) writes that folder's binding, and
 * (4) registers the musterd MCP server there with autojoin, for the chosen harness. Opening a session
 * of that harness in the printed folder then *is* that agent, with no binding thrash against your own
 * seat.
 *
 * `--harness <claude-code|cursor|codex>` picks the harness to wire (default claude-code) — the same
 * pluggable adapters `musterd init` uses (ADR 038/085), so a Cursor or Codex user gets a genuinely
 * wired workspace, not a Claude-Code-only one. `--here` keeps the legacy single-folder behavior;
 * `--path <dir>` targets an explicit folder.
 */
export async function agentCommand(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[0];
  if (!name || /\s/.test(name)) {
    throw new CliError(
      'usage: musterd agent <name> [--role <role>] [--model <id>] [--harness <claude-code|cursor|codex>] [--here | --path <dir>]',
      2,
    );
  }
  const role = flagStr(parsed.flags, 'role');
  // Model attestation (ADR 101): persist a *declared* model into the seat's binding.json so the adapter
  // attests by default instead of rotting to `unknown`. `--model` wins, else the ambient env the CLI
  // runs in (MUSTERD_MODEL / ANTHROPIC_MODEL, via the shared resolver). Never a guess — undefined stays
  // honestly `unknown` (warn-never-block); the `init --check` note catches an unattested live seat.
  const model = flagStr(parsed.flags, 'model') ?? resolveAttestedModel(process.env);

  // Which harness to wire (ADR 038/085 registry — the same adapters `init` drives). Default to Claude
  // Code for back-compat; a bad id fails fast with the valid set rather than silently doing nothing.
  const harnessId = flagStr(parsed.flags, 'harness') ?? 'claude-code';
  const harness = HARNESSES.find((h) => h.id === harnessId);
  if (!harness) {
    throw new CliError(
      `unknown harness "${harnessId}" — choose one of: ${HARNESSES.map((h) => h.id).join(', ')}`,
      2,
    );
  }

  // Adding a member is an admin act — needs an active identity (binding/env/--as), like `team add`.
  const { team, http, config } = resolve(parsed.flags);

  // ADR 058 §5: write the seat file first for a file-backed team so the file stays the single writer;
  // db-only teams skip this and the daemon originates. addMember revives a soft-removed name (ADR 065).
  const home = loadConfig().rosterHome[team];
  if (home) writeSeatFile(home, name, { kind: 'agent', ...(role ? { role } : {}) });
  // Declare the seat (v0.3: no per-seat token — the agent claims it with the team agent key on launch).
  // Idempotent: if the seat is already declared (e.g. you ran `team add <name>` first, or re-ran this
  // command), reuse it and just (re)build the workspace instead of dead-ending on a conflict — a
  // ready-to-run workspace is the whole point of this command. Guard against reusing a *human* seat.
  let reused = false;
  try {
    await http.addMember(team, { name, kind: 'agent', ...(role ? { role } : {}) });
  } catch (err) {
    if (!(err instanceof CliError) || err.code !== 'conflict') throw err;
    const { members } = await http.roster(team);
    const existing = members.find((m) => m.name === name);
    if (existing && existing.kind !== 'agent') {
      throw new CliError(
        `"${name}" already exists in "${team}" as a ${existing.kind}, not an agent — ` +
          `pick a different name for the agent workspace`,
        err.exitCode,
      );
    }
    reused = true;
  }
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
    team,
    ...(flagStr(parsed.flags, 'path') ? { path: flagStr(parsed.flags, 'path')! } : {}),
  });

  const binding: Binding = {
    server: config.server,
    team,
    agent_key: agentKey,
    surface: harness.surface,
    claim: { mode: 'seat', name },
    ...(grant !== undefined ? { grant } : {}),
    ...(model !== undefined ? { model } : {}),
  };
  saveBinding(ws.dir, binding);
  // Also write the secret-free committed launch spec (ADR: committed launch spec) so this worktree
  // self-wires via `musterd wire` on a fresh clone/machine — the key stays out of the committed file.
  saveWorkspaceSpec(ws.dir, {
    server: config.server,
    team,
    surface: harness.surface,
    claim: { mode: 'seat', name },
  });

  // Register the MCP server *for the workspace folder*. No secret is baked into any harness config —
  // binding.json stays the single source of truth (ADR 018/115) — and, critically, **we do not name the
  // binding file in the env** (ADR 143).
  //
  // We used to set `MUSTERD_BINDING=<ws.dir>/.musterd/binding.json` here, on the assumption that chdir-ing
  // into `ws.dir` scoped the registration to this worktree: "`claude mcp add -s local` keys off cwd".
  // **That assumption is false.** Claude Code keys its local scope by **repo root**, and every seat
  // worktree (`agents-miley`, `agents-dolly`, …) is a git worktree of the *same* repo — so all of them
  // share one entry, and `MUSTERD_BINDING` was a single global slot that each `musterd agent` overwrote.
  // Provisioning one seat therefore re-pointed *every live session on the machine* at that seat: on
  // 2026-07-13 they all booted as `dolly` and superseded each other off their own seats, mid-task.
  //
  // The env var was never needed here anyway: the adapter anchors on the `.musterd/binding.json` it finds
  // by walking up from its **cwd**, which the harness sets to the session's workspace — a signal that is
  // genuinely per-worktree, unlike the shared config. Omitting it makes the shared entry identical for
  // every seat, and therefore harmless. (The adapter also refuses a cross-workspace `MUSTERD_BINDING`
  // outright now — see `mcp/binding.ts` — so this can't come back through another door.)
  const agentBinding = {
    server: config.server,
    team,
    agent_key: agentKey,
    surface: harness.surface,
    claim: { mode: 'seat', name } as const,
    ...(grant !== undefined ? { grant } : {}),
  };
  const launch = resolveMcpLaunch();
  const entry = {
    command: launch.command,
    args: launch.args,
    env: {
      MUSTERD_SURFACE: harness.surface,
      MUSTERD_AUTOJOIN: '1',
    },
  };
  let mcpError: string | null = null;
  const prevCwd = process.cwd();
  try {
    process.chdir(ws.dir);
    await harness.configure(entry, agentBinding);
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
        harness: harness.id,
        mcpRegistered: mcpError === null,
        granted: grant !== undefined,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(
    `${theme.ok(sym.ok)} ${reused ? 'reused' : 'added'} ${theme.memberName(name, 'agent')} ${theme.meta(`(agent${role ? `, ${role}` : ''})`)} ${reused ? 'on' : 'to'} ${team}\n`,
  );
  const where =
    ws.kind === 'worktree'
      ? `git worktree on branch ${theme.accent(ws.branch ?? '')}`
      : ws.kind === 'folder'
        ? 'folder'
        : 'this folder';
  process.stdout.write(`${theme.ok(sym.ok)} workspace ${ws.dir} ${theme.meta(`(${where})`)}\n`);

  if (mcpError === null) {
    process.stdout.write(
      success(`wired the musterd MCP server there for ${harness.label} (autojoin)`, {
        next: `open a ${harness.label} session in ${ws.dir} — it joins as ${name} automatically`,
      }) + '\n',
    );
  } else {
    // Member + workspace + binding are set up; only the harness wiring failed (e.g. the harness CLI
    // isn't installed). Point at `musterd init` in the folder, which re-runs the same harness adapter.
    process.stdout.write(
      `${theme.warn(sym.warn)} couldn't auto-register the musterd MCP server for ${harness.label} (${mcpError}).\n` +
        theme.meta(
          `  finish the wiring by running \`musterd init\` in ${ws.dir} and choosing ${harness.label} — ` +
            `the binding.json is already written, so it only needs the harness config.`,
        ) +
        '\n',
    );
  }
  return 0;
}
