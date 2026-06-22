import type { MemberKind, MemberSummary } from '@musterd/protocol';
import { flagStr } from '../args.js';
import { HttpClient } from '../client.js';
import { findBinding, identityFromEnv, loadConfig, type Config, type Identity } from '../config.js';
import { CliError } from '../errors.js';
import { openActionNeeded } from '../render/rows.js';

export interface Resolved {
  config: Config;
  team: string;
  identity: Identity;
  http: HttpClient;
}

/**
 * Resolve the active team + identity. Precedence is aligned with the MCP adapter (ADR 018):
 * explicit flags → `MUSTERD_*` env → workspace `.musterd/binding.json` → global config. The
 * binding/env paths key identity to the *workspace*, so two agents on one machine can't collide
 * on the global config's single-slot-per-team (the 2026-06-16 dogfood failure).
 */
export function resolve(flags: Record<string, string | boolean>): Resolved {
  const config = loadConfig();
  const env = process.env;
  const binding = findBinding();
  const envId = identityFromEnv(env);

  const server =
    flagStr(flags, 'server') ?? env['MUSTERD_SERVER'] ?? binding?.server ?? config.server;

  // Candidate identities, highest precedence first.
  const sources: { team: string; identity: Identity }[] = [];
  if (envId) sources.push(envId);
  if (binding) {
    sources.push({
      team: binding.team,
      identity: { name: binding.member, token: binding.token, surface: binding.surface },
    });
  }
  for (const [slug, identity] of Object.entries(config.identities)) {
    sources.push({ team: slug, identity });
  }

  const team = flagStr(flags, 'team') ?? envId?.team ?? binding?.team ?? config.current;
  if (!team) {
    throw new CliError('no team — run: musterd team create <name>', 2);
  }
  const match = sources.find((s) => s.team === team);
  if (!match) {
    throw new CliError(`no identity for team "${team}" — run: musterd join ${team} --as <name>`, 4);
  }
  const asName = flagStr(flags, 'as');
  if (asName && match.identity.name !== asName) {
    throw new CliError(`stored identity for "${team}" is ${match.identity.name}, not ${asName}`, 5);
  }
  return {
    config,
    team,
    identity: match.identity,
    http: new HttpClient({ server, token: match.identity.token }),
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

/** Build a name→kind lookup from a roster (defaults unknown names to 'agent'). */
export function kindLookup(members: MemberSummary[]): (name: string) => MemberKind {
  const map = new Map<string, MemberKind>();
  for (const m of members) map.set(m.name, m.kind);
  return (name: string) => map.get(name) ?? 'agent';
}
