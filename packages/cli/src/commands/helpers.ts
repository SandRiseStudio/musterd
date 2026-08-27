import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  bindingSeat,
  resolveAttestation,
  resolveAttestedModel,
  type MemberKind,
  type MemberSummary,
} from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import {
  findBinding,
  identityFromEnv,
  loadConfig,
  requireUsableBinding,
  type Config,
  type Identity,
} from '../config.js';
import { CliError } from '../errors.js';
import { dischargedIds, openActionNeeded, renderReachabilityNudge } from '../render/rows.js';
import { theme } from '../render/theme.js';

/** Walk up from `startDir` to the folder holding `.musterd/binding.json` (the workspace root), or
 *  null. The anchor for commands that WRITE the binding — never write at bare `process.cwd()`
 *  (the ambient-cwd clobber, ADR 018). */
export function findWorkspaceDir(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, BINDING_DIR, BINDING_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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
  // The STRICT read (ADR 281/282): this binding would BE the acting identity, so a legacy/invalid
  // one throws the configure repair here rather than letting resolution fall through to the global
  // config vault — a broken workspace must never silently act as a different member.
  const binding = requireUsableBinding();
  const envId = identityFromEnv(env);

  const server =
    flagStr(flags, 'server') ?? env['MUSTERD_SERVER'] ?? binding?.server ?? config.server;

  // Candidate identities, highest precedence first, each tagged with its provenance.
  const sources: { team: string; identity: Identity; source: IdentitySource }[] = [];
  if (envId) sources.push({ team: envId.team, identity: envId.identity, source: 'env' });
  // A binding yields a ready identity only when it pins a fixed seat (the name is known up front) AND
  // carries the team agent key (v0.3, ADR 075). A role-pool / chat / keyless binding has no
  // client-side seat — the claim flow (`musterd claim`/`join`) resolves it and caches the result.
  const boundSeat = binding ? bindingSeat(binding) : undefined;
  if (binding && boundSeat && binding.agent_key) {
    sources.push({
      team: binding.team,
      identity: {
        name: boundSeat,
        key: binding.agent_key,
        // A CLI act is intrinsically `cli` (ADR 286) — identity files no longer declare a surface.
        surface: 'cli',
        ...(binding.grant !== undefined ? { grant: binding.grant } : {}),
      },
      source: 'binding',
    });
  }
  // Active identity per team first (so a no-`--as` default resolves to it), then the rest of the
  // vault (ADR 059) so `--as <name>` can name any previously-known identity for the team.
  for (const [slug, identity] of Object.entries(config.identities)) {
    sources.push({ team: slug, identity, source: 'config' });
  }
  for (const si of config.knownIdentities) {
    if (config.identities[si.team]?.name === si.name) continue; // already added as the active one
    sources.push({
      team: si.team,
      identity: { name: si.name, key: si.key, surface: si.surface },
      source: 'config',
    });
  }

  const team = flagStr(flags, 'team') ?? envId?.team ?? binding?.team ?? config.current;
  return {
    config,
    server,
    sources,
    team,
    asName: flagStr(flags, 'as'),
    model: attestedModel(binding, env),
  };
}

/**
 * What a CLI one-shot should attest as its model (ADR 246) — the SAME ADR 158 ladder the MCP
 * adapter uses (`observed > env > binding`), resolved here because this is where the binding is
 * already in hand.
 *
 * Before this, the CLI attested from `MUSTERD_MODEL`/`ANTHROPIC_MODEL` alone. That is the ladder's
 * weakest tier and the one a hook process is least likely to have, so an ambient touch from a
 * SessionStart hook routinely attested nothing while the harness's own observation sat in
 * `binding.model_observed`, seconds old. An unattested ambient row is the newest non-held presence,
 * so `latestAttestedModel` reads its null and the seat silently leaves the ADR 188 pool.
 *
 * No freshness bound on the observation, deliberately and consistently with the adapter, which
 * reads `model_observed` unconditionally: ADR 158's never-erase rule already governs how an
 * observation ages, and inventing a second, CLI-only staleness rule here would let the two surfaces
 * disagree about the same seat — which is the whole thing the shared resolver exists to prevent.
 */
export function attestedModel(
  binding: ReturnType<typeof findBinding>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return resolveAttestation({
    observed: binding?.model_observed,
    env: resolveAttestedModel(env),
    binding: binding?.model,
  }).model;
}

/**
 * Resolve the team + identity for an **act** (anything that writes/acts as a member). An ambient
 * global-config identity is *not* enough — acting requires the identity to be workspace-explicit
 * (env/binding) or named with `--as` (ADR 036). This keeps a bare `cd` into an unrelated folder
 * from silently acting as a real teammate.
 */
export function resolve(flags: Record<string, string | boolean>): Resolved {
  const { config, server, sources, team, asName, model } = gather(flags);
  if (!team) {
    throw new CliError('no team — run: musterd team create <name>', 2);
  }
  // ADR 059: `--as <name>` resolves any vault identity for the team, not just the active one.
  const match = sources.find((s) => s.team === team && (!asName || s.identity.name === asName));
  if (!match) {
    const who = asName ? ` as ${asName}` : '';
    throw new CliError(
      `no identity for team "${team}"${who} — run: musterd join ${team} --as <name>`,
      4,
    );
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
      key: match.identity.key,
      seat: match.identity.name,
      surface: match.identity.surface,
      ...(model !== undefined ? { model } : {}),
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
  const { config, server, sources, team, asName, model } = gather(flags);
  if (!team) {
    throw new CliError('no team — run: musterd team create <name>', 2);
  }
  // ADR 059: prefer an exact `--as` match from the vault; fall back to the team's active identity.
  const match =
    sources.find((s) => s.team === team && (!asName || s.identity.name === asName)) ??
    (asName ? undefined : sources.find((s) => s.team === team));
  let identity: Identity | undefined;
  let identitySource: IdentitySource | undefined;
  let explicit = false;
  if (match) {
    identity = match.identity;
    explicit = match.source === 'env' || match.source === 'binding' || asName != null;
    identitySource = match.source === 'config' && asName ? 'flag' : match.source;
  }
  return {
    config,
    team,
    server,
    http: new HttpClient(
      identity
        ? {
            server,
            key: identity.key,
            seat: identity.name,
            surface: identity.surface,
            ...(model !== undefined ? { model } : {}),
          }
        : { server },
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
  const waiting = openActionNeeded(res.messages, me, res.answered ?? [], dischargedIds(res));
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
  'nudge',
  'status',
  'serve',
  'service',
  'init',
  'wire',
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

/**
 * The ADR 185 explicit-vs-inherited marker. A key the stored (sparse) policy does not carry is
 * inherited from the shipped schema default, and will move when that default moves — which is the
 * fact the old dense storage hid, and the reason a recalibration could silently reach nothing.
 */
export function inherited(stored: Record<string, unknown> | undefined, key: string): string {
  return stored && key in stored ? '' : theme.meta('  ·  default');
}
