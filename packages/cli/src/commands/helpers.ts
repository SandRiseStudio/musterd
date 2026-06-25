import { isClaimed, type MemberKind, type MemberSummary } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { findBinding, identityFromEnv, loadConfig, type Config, type Identity } from '../config.js';
import { CliError } from '../errors.js';
import { openActionNeeded, renderReachabilityNudge } from '../render/rows.js';

/**
 * Where a resolved identity came from. `env`/`binding` are workspace-explicit; `flag` means the
 * caller named it with `--as`; `config` is the ambient global-config fallback — a *credential store*
 * default that may **read** but never **act** (ADR 036).
 */
export type IdentitySource = 'env' | 'binding' | 'flag' | 'config';

export interface Resolved {
  config: Config;
  team: string;
  identity: Identity;
  identitySource: IdentitySource;
  /** True when the identity is workspace-explicit (env/binding) or named via `--as`. Acts require it. */
  explicit: boolean;
  http: HttpClient;
}

/** The read/operator resolution: a team is required, an identity is not (ADR 036). */
export interface ResolvedRead {
  config: Config;
  team: string;
  server: string;
  http: HttpClient;
  identity?: Identity;
  identitySource?: IdentitySource;
  explicit: boolean;
}

/**
 * Gather candidate identities + the active team. Precedence is aligned with the MCP adapter
 * (ADR 018): explicit flags → `MUSTERD_*` env → workspace `.musterd/binding.json` → global config.
 * The binding/env paths key identity to the *workspace*, so two agents on one machine can't collide
 * on the global config's single-slot-per-team (the 2026-06-16 dogfood failure).
 */
function gather(flags: Record<string, string | boolean>) {
  const config = loadConfig();
  const env = process.env;
  const binding = findBinding();
  const envId = identityFromEnv(env);

  const server =
    flagStr(flags, 'server') ?? env['MUSTERD_SERVER'] ?? binding?.server ?? config.server;

  // Candidate identities, highest precedence first, each tagged with its provenance.
  const sources: { team: string; identity: Identity; source: IdentitySource }[] = [];
  if (envId) sources.push({ team: envId.team, identity: envId.identity, source: 'env' });
  // A policy-only (unclaimed) binding carries no identity yet — skip it as an identity source
  // (the caller resolves identity by claiming; see `musterd claim`).
  if (binding && isClaimed(binding)) {
    sources.push({
      team: binding.team,
      identity: { name: binding.member, token: binding.token, surface: binding.surface },
      source: 'binding',
    });
  }
  for (const [slug, identity] of Object.entries(config.identities)) {
    sources.push({ team: slug, identity, source: 'config' });
  }

  const team = flagStr(flags, 'team') ?? envId?.team ?? binding?.team ?? config.current;
  return { config, server, sources, team, asName: flagStr(flags, 'as') };
}

/**
 * Resolve the team + identity for an **act** (anything that writes/acts as a member). An ambient
 * global-config identity is *not* enough — acting requires the identity to be workspace-explicit
 * (env/binding) or named with `--as` (ADR 036). This keeps a bare `cd` into an unrelated folder
 * from silently acting as a real teammate.
 */
export function resolve(flags: Record<string, string | boolean>): Resolved {
  const { config, server, sources, team, asName } = gather(flags);
  if (!team) {
    throw new CliError('no team — run: musterd team create <name>', 2);
  }
  const match = sources.find((s) => s.team === team);
  if (!match) {
    throw new CliError(`no identity for team "${team}" — run: musterd join ${team} --as <name>`, 4);
  }
  if (asName && match.identity.name !== asName) {
    throw new CliError(`stored identity for "${team}" is ${match.identity.name}, not ${asName}`, 5);
  }
  const explicit = match.source === 'env' || match.source === 'binding' || asName != null;
  if (!explicit) {
    throw new CliError(
      `no active identity in this folder for team "${team}" — ` +
        `run: musterd claim <name>  (bind this folder), or pass --as ${match.identity.name}`,
      4,
    );
  }
  const identitySource: IdentitySource =
    match.source === 'config' && asName ? 'flag' : match.source;
  return {
    config,
    team,
    identity: match.identity,
    identitySource,
    explicit: true,
    http: new HttpClient({
      server,
      token: match.identity.token,
      surface: match.identity.surface,
    }),
  };
}

/**
 * Resolve for a **read/operator** command: a team is required, an identity is optional. Returns the
 * ambient identity (if any) plus whether it is `explicit`, so callers can show member-specific
 * signal (e.g. the comeback summary) only when someone is genuinely active here (ADR 036). Never
 * refuses on a missing/ambient identity — `status` must still print the (auth-free) roster anywhere.
 */
export function resolveRead(flags: Record<string, string | boolean>): ResolvedRead {
  const { config, server, sources, team, asName } = gather(flags);
  if (!team) {
    throw new CliError('no team — run: musterd team create <name>', 2);
  }
  const match = sources.find((s) => s.team === team);
  let identity: Identity | undefined;
  let identitySource: IdentitySource | undefined;
  let explicit = false;
  if (match && (!asName || match.identity.name === asName)) {
    identity = match.identity;
    explicit = match.source === 'env' || match.source === 'binding' || asName != null;
    identitySource = match.source === 'config' && asName ? 'flag' : match.source;
  }
  return {
    config,
    team,
    server,
    http: new HttpClient(
      identity ? { server, token: identity.token, surface: identity.surface } : { server },
    ),
    explicit,
    ...(identity ? { identity } : {}),
    ...(identitySource ? { identitySource } : {}),
  };
}

/**
 * The "what's waiting for me" summary, read off the durable inbox cursor: how many unread
 * action-needed messages (request_help / @me) the member has, and the oldest one's timestamp.
 * Threads that carry a `resolve` are dropped — a closed request no longer waits (ADR 025) — so this
 * is the open-vs-done view ADR 024's read-cursor alone couldn't give. Returns undefined when nothing
 * waits. The comeback / return-path half of the human-reachability nudge (ADR 024) — it needs no
 * resident process, just a normal inbox read.
 */
export async function pendingActionSummary(
  http: HttpClient,
  team: string,
  me: string,
): Promise<{ count: number; since: number } | undefined> {
  const res = await http.inbox(team, { unread: true });
  const waiting = openActionNeeded(res.messages, me);
  if (waiting.length === 0) return undefined;
  const since = waiting.reduce((min, m) => Math.min(min, m.ts), Infinity);
  return { count: waiting.length, since };
}

/**
 * Commands that carry no acting identity, or already surface the pending acts themselves, so the
 * post-command reachability nudge (ADR 046) is skipped for them: `inbox` renders the acts and
 * `status` leads with the comeback summary (double-surfacing); the rest re-resolve to nothing
 * anyway, but listing them keeps the intent explicit and avoids a pointless inbox read.
 */
const NUDGE_SKIP_COMMANDS = new Set([
  'inbox',
  'status',
  'serve',
  'service',
  'init',
  'reset',
  'role',
  'uninstall',
]);

/**
 * The agent-side reachability nudge (ADR 046): after an acting command runs, re-resolve the identity
 * and — only when it is *explicit* (an env/binding/`--as` actor, never an ambient global-config read,
 * ADR 036) — return a one-line banner naming the directed acts waiting for that member. Returns '' to
 * print nothing. Best-effort and silent on any failure: the nudge must never fail a command. Honours
 * `--json`/`--quiet`/`MUSTERD_NO_NUDGE=1` (scripts that want a clean sidecar) and skips commands that
 * either show the acts already or carry no identity ({@link NUDGE_SKIP_COMMANDS}).
 */
export async function reachabilityNudge(command: string, parsed: Parsed): Promise<string> {
  if (NUDGE_SKIP_COMMANDS.has(command)) return '';
  if (parsed.flags['json'] === true || parsed.flags['quiet'] === true) return '';
  if (process.env['MUSTERD_NO_NUDGE'] === '1') return '';
  try {
    const { http, team, identity, explicit } = resolveRead(parsed.flags);
    if (!explicit || !identity) return '';
    const pending = await pendingActionSummary(http, team, identity.name);
    if (!pending) return '';
    return renderReachabilityNudge(pending.count, pending.since, identity.name);
  } catch {
    return '';
  }
}

/** Build a name→kind lookup from a roster (defaults unknown names to 'agent'). */
export function kindLookup(members: MemberSummary[]): (name: string) => MemberKind {
  const map = new Map<string, MemberKind>();
  for (const m of members) map.set(m.name, m.kind);
  return (name: string) => map.get(name) ?? 'agent';
}
