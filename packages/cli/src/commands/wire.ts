import { type Binding, bindingSeat, type ClaimPolicy } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { findBinding, loadConfig, loadWorkspace, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import type { Harness } from '../onboard/harness.js';
import { claudeCode } from '../onboard/harnesses/claudeCode.js';
import { HARNESSES } from '../onboard/harnesses/index.js';
import { loadProvisioning } from '../onboard/manifest.js';
import { defaultHarnessContext, type HarnessContext } from '../onboard/reconcile/context.js';
import { reconcileHarnesses, type ReconcileResult } from '../onboard/reconcile/engine.js';
import type { HarnessAdapter } from '../onboard/reconcile/fragments.js';
import { theme } from '../render/theme.js';

/**
 * `musterd wire` — the headless, no-prompt counterpart to `musterd harness configure` for a folder
 * that already carries a **committed** `.musterd/workspace.json` (the secret-free v2 launch spec)
 * and a SAVED harness selection (`.musterd/provisioned.json`, v2). It resolves the team agent key
 * from local sources (never the committed file), materializes the gitignored binding, and
 * reconciles this worktree's desired fragment set crash-safely (ADR 282).
 *
 * Wire never prompts, never edits desire, and never converts pre-ADR-281 state: a folder with no
 * valid v2 selection exits 6 and names `musterd harness configure` as the repair; a legacy launch
 * marker is REPORTED (`repair-needed`), never repaired — only confirmed configure may do that
 * (ADR 286 §1).
 *
 * "Wire" = make the `team_*` tools available, NOT claim a seat: it does **not** enable autojoin by
 * default, so a shared repo cloned by many never has every clone auto-claim the same seat.
 * `--autojoin` opts a personal worktree into claim-on-launch, written to `binding.autojoin`.
 */
export interface WireDeps {
  ctx?: HarnessContext;
  registry?: HarnessAdapter[];
}

const CONFIGURE_REPAIR =
  'no harness selection here — run musterd harness configure (or musterd init for a fresh folder)';

export async function wireCommand(parsed: Parsed, deps?: WireDeps): Promise<number> {
  const flags = parsed.flags;
  const cwd = process.cwd();

  // ── Require valid v2 local state; never prompt, never convert (ADR 281 clean break). ──────────
  const workspace = loadWorkspace(cwd);
  if (workspace.kind === 'missing') {
    throw new CliError(
      'no .musterd/workspace.json here — this folder has no committed musterd launch spec. ' +
        'Run `musterd init` to set it up (which writes the spec), or check you are in the right folder.',
      6,
    );
  }
  if (workspace.kind === 'legacy') {
    throw new CliError(
      'this worktree is pre-ADR-281 (version-1 identity) — run `musterd harness configure` to ' +
        'convert it. Wire never converts local state.',
      6,
    );
  }
  if (workspace.kind === 'invalid') {
    throw new CliError(
      '.musterd/workspace.json exists but is not a readable v2 launch spec — repair it or re-run ' +
        '`musterd init`.',
      6,
    );
  }
  const spec = workspace.value;
  const ctx = deps?.ctx ?? defaultHarnessContext(cwd, process.env, { team: spec.team });
  const provisioning = loadProvisioning(ctx.worktreeRoot, ctx.fs);
  if (provisioning.kind !== 'valid') {
    throw new CliError(
      provisioning.kind === 'legacy'
        ? "this folder's provisioning manifest is pre-ADR-281 (version 1) — run `musterd harness " +
            'configure` to choose and convert the harness set. Wire never converts local state.'
        : CONFIGURE_REPAIR,
      6,
    );
  }
  const desired = provisioning.value.desired;

  const config = loadConfig();
  const server = flagStr(flags, 'server') ?? spec.server;
  const team = spec.team;

  // Resolve the agent key locally — the whole point of the split: the key is NEVER in the committed
  // spec. Same precedence as `agent`/`init`: --key → env → this machine's global config.
  const agentKey =
    flagStr(flags, 'key') ?? process.env['MUSTERD_AGENT_KEY'] ?? config.agentKeys[team];
  const grant = flagStr(flags, 'grant') ?? process.env['MUSTERD_GRANT'];
  const autojoin = flags['autojoin'] === true;

  // Materialize the gitignored binding.json (spec + resolved secrets) so subsequent CLI acts in
  // this folder resolve identity. A keyless binding is valid (a chat/human folder). Runtime fields
  // the seat already carries (model declaration, autojoin, driver) are preserved, not re-derived —
  // legitimate binding runtime fields survive a re-wire (ADR 282 acceptance).
  const claim: ClaimPolicy = spec.claim ?? { mode: 'chat' };
  const prior = findBinding();
  const bindingAutojoin = autojoin || prior?.autojoin === true;
  const binding: Binding = {
    version: 2,
    server,
    team,
    claim,
    ...(agentKey !== undefined ? { agent_key: agentKey } : {}),
    ...(grant !== undefined ? { grant } : {}),
    ...(prior?.model !== undefined ? { model: prior.model } : {}),
    ...(bindingAutojoin ? { autojoin: true } : {}),
    ...(prior?.driver !== undefined ? { driver: prior.driver } : {}),
  };
  saveBinding(cwd, binding);

  // ── Reconcile actual state to the SAVED desire. Never `legacyRepair` from here. ───────────────
  const report = await reconcileHarnesses(ctx, desired, {
    legacyRepair: false,
    ...(deps?.registry ? { registry: deps.registry } : {}),
  });

  const seat = bindingSeat(binding) ?? null;

  if (flags['json']) {
    process.stdout.write(
      JSON.stringify({
        team,
        member: seat,
        desired,
        results: report.results,
        keyResolved: agentKey !== undefined,
        autojoin: bindingAutojoin,
      }) + '\n',
    );
    return report.ok ? 0 : 1;
  }

  for (const r of report.results) process.stdout.write(`${renderWireResult(r)}\n`);
  if (report.ok) {
    process.stdout.write(
      `${theme.ok('✓')} wired this worktree's harness set ${theme.meta(`(team ${team}${desired.length > 0 ? `, ${desired.join(', ')}` : ', empty selection'})`)}\n`,
    );
    const target = seat ? `as ${theme.memberName(seat, 'agent')}` : `(assign a seat in chat)`;
    process.stdout.write(
      bindingAutojoin
        ? `${theme.dim(`this session will come online ${seat ? target : ''} automatically on launch.`)}\n`
        : `${theme.dim(`the team_* tools are available — join when ready (team_join / musterd claim ${seat ?? '<name>'}). Reload the session to pick up the tools.`)}\n`,
    );
  } else {
    process.stdout.write(
      `${theme.warn('⚠')} some fragments need attention — \`musterd harness status\` for the detail, ` +
        '`musterd harness configure` for a legacy conversion.\n',
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
  return report.ok ? 0 : 1;
}

function renderWireResult(r: ReconcileResult): string {
  const head = `  ${r.harness.padEnd(13)} ${r.action === 'none' ? '' : `(${r.action}) `}`;
  if (r.result === 'applied' || r.result === 'unchanged')
    return `${head}${theme.ok('✓')} ${r.result}`;
  if (r.result === 'satisfied-unmanaged') return `${head}${theme.ok('✓')} satisfied (unmanaged)`;
  if (r.result === 'pending') return `${head}· pending (${r.detail ?? 'not installed here'})`;
  return `${head}${theme.err('✗')} ${r.result}${r.detail ? ` — ${r.detail}` : ''}`;
}

/**
 * The harness `musterd wire`'s doctor-facing predicate historically dispatched on. Retained for the
 * doctor's prescriptions until it is rebuilt on `inspectHarnesses` — since ADR 281 the manifest's
 * harness id is the record of the choice (identity declares no surface). Undefined degrades to
 * Claude Code, which is what wire did for every folder before this.
 */
export function harnessWiredFor(declared: string | undefined): Harness {
  return (declared ? HARNESSES.find((h) => h.surface === declared) : undefined) ?? claudeCode;
}

/** Will `wire`, run in a folder that provisioned `declared`, rewrite this harness's entry? */
export function wireConfigures(harnessId: string, declared: string | undefined): boolean {
  return harnessWiredFor(declared).id === harnessId;
}
