import { type Binding, bindingSeat, type ClaimPolicy } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { findBinding, findWorkspaceSpec, loadConfig, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import type { Harness } from '../onboard/harness.js';
import { claudeCode } from '../onboard/harnesses/claudeCode.js';
import { HARNESSES } from '../onboard/harnesses/index.js';
import { buildEntry } from '../onboard/mcpEntry.js';
import { theme } from '../render/theme.js';

/**
 * `musterd wire` — the headless, no-prompt counterpart to `musterd init` for a folder that already
 * carries a **committed** `.musterd/workspace.json` (the secret-free launch spec, written by
 * `init`/`agent`). It reads that spec, resolves the team agent key from local sources (never the
 * committed file — the spec has no secret), and registers the musterd MCP server for this folder. This
 * is what lets a fresh clone/worktree self-wire without an interactive `init` (the ADR-060 non-goal,
 * unblocked by the committed spec).
 *
 * "Wire" = make the `team_*` tools available, NOT claim a seat: it does **not** enable autojoin by
 * default, so a shared repo cloned by many never has every clone auto-claim the same seat — the
 * session stays dormant until it joins explicitly (`team_join` / `musterd claim`). `--autojoin` opts a
 * personal worktree into claim-on-launch, written to `binding.autojoin` (per-worktree, ADR 165 inc 2 —
 * never the repo-root-shared entry). The spec's `claim` policy still tells the adapter *which*
 * seat to occupy when it does join.
 */
/**
 * The harness `wire` rewrites the musterd MCP entry for, in a folder that declares `surface`.
 *
 * Exported because the doctor PRESCRIBES `musterd wire` as the repair for entry drift, and that
 * advice is only true for the harness wire will actually reach *in that folder*. This used to be the
 * literal `['claude-code']`, which made wire a Claude-Code-only command by construction: a Codex seat
 * whose `.codex/config.toml` baked a stale `MUSTERD_SURFACE` — a wire-time snapshot that outranks
 * binding.json and that no observation can correct — was told to hand-edit the file or re-run the
 * interactive `init`. Neither is a repair a check can offer (ADR 168: a detector whose prescribed fix
 * has no safe form is half a feature), so the drift re-flagged on every `--check` forever, and a
 * permanently-red check nobody can clear teaches everyone to skim the ✗ block.
 *
 * Every harness already implements the idempotent, promptless `configure` this needs; nothing but the
 * hard-coded list stood between them and a working repair.
 *
 * The folder's *declared* surface decides, not what happens to be installed on the machine: wire
 * repairs the entry this folder was provisioned with, and never conjures a first install for a
 * harness the folder never picked (that is `init`'s job — the same line `refreshHooks.applies`
 * draws). `surface` is a Presence surface rather than a harness id, so legitimate values (`cli`,
 * `other`, or none at all in a spec written before the field existed) name no adapter; those degrade
 * to Claude Code, which is what wire did for every folder before this.
 */
export function harnessWiredFor(surface: string | undefined): Harness {
  // An undeclared surface must never *match* — `find` on an undefined needle would otherwise pair it
  // with the first harness that happens to have no surface, which is a coincidence, not a decision.
  return (surface ? HARNESSES.find((h) => h.surface === surface) : undefined) ?? claudeCode;
}

/** Will `wire`, run in a folder declaring `surface`, rewrite this harness's entry? */
export function wireConfigures(harnessId: string, surface: string | undefined): boolean {
  return harnessWiredFor(surface).id === harnessId;
}

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
  // The shared entry carries nothing (ADR 165, completed by inc 2) — `--autojoin` is per-worktree
  // state and goes into binding.json below, never into the repo-root-shared slot.
  const entry = buildEntry(agentBinding);

  const harness = harnessWiredFor(spec.surface);
  let mcpError: string | null = null;
  try {
    // Every adapter writes for the CURRENT folder — `claude mcp add -s local` keys off cwd, and the
    // per-folder harnesses write `.cursor/mcp.json` / `.codex/config.toml` under it — so no chdir.
    await harness.configure(entry, agentBinding);
  } catch (err) {
    mcpError = (err as Error).message;
  }

  // Materialize the gitignored binding.json (spec + resolved secrets) so subsequent CLI acts in this
  // folder resolve identity — mirrors `init`. A keyless binding is valid (a chat/human folder).
  // A re-wire must not forget what the seat attests: the model is a per-machine declaration that lives
  // only in the gitignored binding (never the committed spec), so re-deriving the binding from the spec
  // would drop it (ADR 101). Carry the existing declaration forward.
  const prior = findBinding();
  // `--autojoin` opts this worktree in; otherwise keep what the binding already says (a re-wire must
  // not silently flip a seat provisioned by `musterd agent` back to dormant). Driver is per-machine
  // state like model — carry it forward the same way (ADR 165 inc 2).
  const bindingAutojoin = autojoin || prior?.autojoin === true;
  const binding: Binding = {
    server,
    team,
    surface: spec.surface,
    claim,
    ...(agentKey !== undefined ? { agent_key: agentKey } : {}),
    ...(grant !== undefined ? { grant } : {}),
    ...(prior?.model !== undefined ? { model: prior.model } : {}),
    ...(bindingAutojoin ? { autojoin: true } : {}),
    ...(prior?.driver !== undefined ? { driver: prior.driver } : {}),
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
        autojoin: bindingAutojoin,
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
      bindingAutojoin
        ? `${theme.dim(`this session will come online ${seat ? target : ''} automatically on launch.`)}\n`
        : `${theme.dim(`the team_* tools are available — join when ready (team_join / musterd claim ${seat ?? '<name>'}). Reload the session to pick up the tools.`)}\n`,
    );
  } else {
    // The manual fallback is Claude Code's CLI, so it can only be offered when Claude Code is the
    // harness that failed. Printing it for a Codex folder would hand the reader a command that
    // registers the server in the wrong harness entirely — the same "repair that cannot work" this
    // function's doc-comment is about.
    process.stdout.write(
      `${theme.warn('⚠')} couldn't register the musterd MCP server for ${harness.label} (${mcpError}).` +
        (harness.id === 'claude-code'
          ? ' Register it here with:\n' +
            theme.meta(
              `  claude mcp add musterd -s local ` +
                Object.entries(entry.env)
                  .map(([k, v]) => `-e ${k}=${v}`)
                  .join(' ') +
                ` -- ${entry.command} ${entry.args.join(' ')}`,
            ) +
            '\n'
          : ` Re-provision this folder with \`musterd init\` and pick ${harness.label}.\n`),
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
