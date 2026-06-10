import type { MemberKind, MemberSummary } from '@musterd/protocol';
import { HttpClient } from '../client.js';
import { loadConfig, type Config, type Identity } from '../config.js';
import { CliError } from '../errors.js';
import { flagStr } from '../args.js';

export interface Resolved {
  config: Config;
  team: string;
  identity: Identity;
  http: HttpClient;
}

/** Resolve the active team + identity from flags then config. Throws if none configured. */
export function resolve(flags: Record<string, string | boolean>): Resolved {
  const config = loadConfig();
  const server = flagStr(flags, 'server') ?? config.server;
  const team = flagStr(flags, 'team') ?? config.current;
  if (!team) {
    throw new CliError('no team — run: musterd team create <name>', 2);
  }
  const asName = flagStr(flags, 'as');
  const identity = config.identities[team];
  if (!identity) {
    throw new CliError(`no identity for team "${team}" — run: musterd join ${team} --as <name>`, 4);
  }
  if (asName && identity.name !== asName) {
    throw new CliError(`stored identity for "${team}" is ${identity.name}, not ${asName}`, 5);
  }
  return { config, team, identity, http: new HttpClient({ server, token: identity.token }) };
}

/** Build a name→kind lookup from a roster (defaults unknown names to 'agent'). */
export function kindLookup(members: MemberSummary[]): (name: string) => MemberKind {
  const map = new Map<string, MemberKind>();
  for (const m of members) map.set(m.name, m.kind);
  return (name: string) => map.get(name) ?? 'agent';
}
