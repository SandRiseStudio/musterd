import {
  isClaimed,
  nextRoleHandle,
  type Binding,
  type ClaimPolicy,
  type MemberSummary,
} from '@musterd/protocol';
import pc from 'picocolors';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { findBinding, loadConfig, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import {
  consumePending,
  listPendingForWorkspace,
  writeResolution,
  type PendingMarker,
} from '../onboard/pending.js';
import { theme } from '../render/theme.js';

/** What the caller asked to claim — a named seat, or the next open seat in a role pool. */
export type ClaimTarget = { seat: string } | { role: string };

/**
 * `musterd claim <name>` / `--role <x>` — the L2 universal floor of claim-on-first-use
 * (provisioning-recipe.md §6; ADR 032). Needs only the daemon and works in any harness: it
 * mint-or-reuses the seat (locally, claiming auto-mints — naming "Ada" provisions + claims it) and
 * writes it into this folder's `.musterd/binding.json` (ADR 018) so both the CLI and a (re)launched
 * adapter resolve to it. Conflict is honest about local limits: a name already on the team that this
 * folder doesn't hold a token for can't be re-occupied here (token reissue is the v0.3 grant model).
 */
export async function claimCommand(parsed: Parsed): Promise<number> {
  const flags = parsed.flags;
  const config = loadConfig();
  const binding = findBinding();
  const server =
    flagStr(flags, 'server') ?? process.env['MUSTERD_SERVER'] ?? binding?.server ?? config.server;
  const team =
    flagStr(flags, 'team') ?? process.env['MUSTERD_TEAM'] ?? binding?.team ?? config.current;
  if (!team) {
    throw new CliError('no team — run init, or pass --team <slug>', 2);
  }

  const target = resolveTarget(parsed, binding);
  // The seat the adapter will occupy keeps its harness surface; a bare CLI claim defaults to `cli`.
  const surface = flagStr(flags, 'surface') ?? binding?.surface ?? 'cli';

  const http = new HttpClient({ server });
  const { members } = await http.roster(team);

  // Disambiguate which pending session (if any) this claim is for. Informational + lets `--for`
  // scope the marker that gets cleared; identity delivery is via the binding either way (ADR 033).
  const pendings = listPendingForWorkspace(process.cwd(), team);
  const forCode = flagStr(flags, 'for');
  if (!forCode && pendings.length > 1) {
    const list = pendings
      .map((p) => `  ${pc.bold(p.code)}  ${p.surface}${p.driver ? ` · driven by ${p.driver}` : ''}`)
      .join('\n');
    throw new CliError(
      `several unclaimed sessions are waiting here — re-run with --for <code>:\n${list}`,
      2,
    );
  }
  const marker: PendingMarker | undefined =
    (forCode ? pendings.find((p) => p.code === forCode) : pendings[0]) ?? undefined;
  if (forCode && !marker) {
    throw new CliError(`no pending session with code "${forCode}" in this folder`, 2);
  }

  const result = await claimSeat(http, team, target, {
    binding,
    members,
    adoptToken: flagStr(flags, 'token'),
    surface,
    server,
  });

  const next: Binding = {
    server,
    team,
    member: result.member,
    token: result.token,
    surface: surface as Binding['surface'],
    // Record the resolved seat as the folder's standing policy so re-launches re-occupy it.
    claim: { mode: 'seat', name: result.member },
  };
  saveBinding(process.cwd(), next);
  // Bring the matched running session online now (ADR 034): hand it the seat via a resolution
  // sidecar its watcher adopts, then drop the discovery marker so it isn't re-listed.
  let live = false;
  if (marker) {
    writeResolution(process.cwd(), marker.code, { member: result.member, token: result.token });
    consumePending(process.cwd(), marker.code);
    live = true;
  }

  if (flags['json']) {
    process.stdout.write(
      JSON.stringify({ team, member: result.member, reused: result.reused, live }) + '\n',
    );
    return 0;
  }
  const how = result.adopted
    ? 'adopted the seat'
    : result.reused
      ? 'reclaimed your seat'
      : 'claimed a fresh seat';
  const tail = live
    ? `the waiting ${marker!.surface} session is going online as ${result.member} now.`
    : `bound this folder to ${result.member}; the agent here will occupy it on launch (or call team_join).`;
  process.stdout.write(
    `${theme.ok('✓')} ${theme.memberName(result.member, 'agent')} — ${how} on ${team}\n` +
      `${pc.dim(tail)}\n`,
  );
  return 0;
}

interface ClaimContext {
  binding: Binding | null;
  members: MemberSummary[];
  /** The seat's token (the code a teammate's `team add` printed), to adopt an existing seat (ADR 055). */
  adoptToken?: string | undefined;
  surface?: string | undefined;
  server: string;
}
export interface ClaimResult {
  member: string;
  token: string;
  /** True when we re-occupied the folder's own already-bound seat rather than minting a new one. */
  reused: boolean;
  /** True when we adopted a teammate-created seat by its token (ADR 055) rather than minting. */
  adopted?: boolean;
}

/**
 * Mint-or-reuse a seat against the daemon. Local, frictionless (ADR 032): minting is the
 * unauthenticated `POST /members`, and a unique-name collision IS the `claim_conflict` signal —
 * another session already holds that name and we don't have its token, so we refuse rather than
 * impersonate, pointing at a role pool / a fresh name (the recipe's "offer free seats").
 */
export async function claimSeat(
  http: HttpClient,
  team: string,
  target: ClaimTarget,
  ctx: ClaimContext,
): Promise<ClaimResult> {
  if ('seat' in target) {
    const name = target.seat;
    // Re-occupy the folder's own seat without re-minting (we hold its token): own reload / re-claim.
    if (ctx.binding && isClaimed(ctx.binding) && ctx.binding.member === name) {
      return { member: name, token: ctx.binding.token, reused: true };
    }
    // Adopt a seat a teammate created for us (ADR 055): we already hold its token (the code their
    // `team add` printed), so bind it to THIS folder — no mint, and no global-config clobber the way
    // `join --token` does. Validate the token by registering presence, and refuse if it authenticates
    // as a different member (the silent mismatch `join` warns about).
    if (ctx.adoptToken) {
      let who: string | undefined;
      try {
        const authed = new HttpClient({ server: ctx.server, token: ctx.adoptToken });
        who = (await authed.presence(team, ctx.surface ?? 'cli')).member;
      } catch {
        throw new CliError(
          `that token didn't authenticate against ${team} — re-check the code from whoever ran ` +
            `\`musterd team add ${name}\``,
          4,
        );
      }
      if (who && who !== name) {
        throw new CliError(
          `that token belongs to "${who}", not "${name}" — run \`musterd claim ${who} --token <code>\`, ` +
            `or get ${name}'s own code`,
          4,
        );
      }
      return { member: name, token: ctx.adoptToken, reused: false, adopted: true };
    }
    try {
      const res = await http.addMember(team, { name, kind: 'agent' });
      return { member: name, token: res.token as string, reused: false };
    } catch (err) {
      if (isConflict(err)) throw conflictError(name, ctx.members);
      throw err;
    }
  }
  // Role pool: claim the next open <role>-<n>. One retry covers a racing mint of the same handle.
  const role = target.role;
  const taken = new Set(ctx.members.map((m) => m.name));
  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = nextRoleHandle(role, taken);
    try {
      const res = await http.addMember(team, { name: handle, kind: 'agent', role });
      return { member: handle, token: res.token as string, reused: false };
    } catch (err) {
      if (isConflict(err)) {
        taken.add(handle); // lost the race for this handle; try the next one
        continue;
      }
      throw err;
    }
  }
  throw new CliError(`couldn't find a free seat in role "${role}" — try again`, 9);
}

function resolveTarget(parsed: Parsed, binding: Binding | null): ClaimTarget {
  const name = parsed.positionals[0];
  const role = flagStr(parsed.flags, 'role');
  if (name && role) {
    throw new CliError('pass a seat name or --role <x>, not both', 2);
  }
  if (name) return { seat: name };
  if (role) return { role };
  // No explicit target → fall back to the folder claim policy (ADR 018 ladder), if any.
  const policy = bindingPolicy(parsed, binding);
  if (policy.mode === 'seat') return { seat: policy.name };
  if (policy.mode === 'role') return { role: policy.role };
  throw new CliError(
    'name the seat to claim: `musterd claim <name>` or `musterd claim --role <role>`',
    2,
  );
}

function bindingPolicy(_parsed: Parsed, binding: Binding | null): ClaimPolicy {
  return binding?.claim ?? { mode: 'chat' };
}

/** The CLI surfaces the server's unique-name `conflict` (409) as exit code 9 (see errors.ts). */
function isConflict(err: unknown): boolean {
  return err instanceof CliError && err.exitCode === 9;
}

function conflictError(name: string, members: MemberSummary[]): CliError {
  const taken = members.map((m) => m.name);
  const hint = taken.length > 0 ? ` Names on the team: ${taken.join(', ')}.` : '';
  // ADR 055 no-dead-end rule: a name-conflict must name a runnable next step, not just refuse.
  return new CliError(
    `"${name}" is already a seat and this folder doesn't hold its token. ` +
      `If a teammate created it for you, adopt it: musterd claim ${name} --token <code> ` +
      `(the code their \`musterd team add\` printed). ` +
      `Otherwise take a fresh pool seat: musterd claim --role <role>, or pick another name.${hint}`,
    9,
  );
}
