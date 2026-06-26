import type { Binding } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig, rememberIdentity, saveBinding, saveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

/** Register a presence for an existing member and store the identity locally. */
export async function joinCommand(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[0];
  const name = flagStr(parsed.flags, 'as');
  if (!slug || !name) {
    throw new CliError('usage: musterd join <slug> --as <name> [--token <tok>] [--surface cli]', 2);
  }
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const surface = flagStr(parsed.flags, 'surface') ?? 'cli';

  // Only reuse the cached token when it belongs to the member we're joining as. Relabeling
  // another member's token as `name` would "succeed" here, then fail every send with
  // `from/team must match the authenticated member` (the token authenticates as someone else).
  // The global config has one identity slot per team, so two agents on one machine collide here.
  const explicitToken = flagStr(parsed.flags, 'token');
  // ADR 059: reuse a cached token for *this* member from the vault, even if another member is the
  // team's active identity — so re-joining as a previously-known member doesn't need --token again.
  const cached = config.knownIdentities.find((i) => i.team === slug && i.name === name);
  const token = explicitToken ?? cached?.token;
  if (!token) {
    throw new CliError(`no token for "${name}" on "${slug}" — pass --token <tok>`, 4);
  }

  const http = new HttpClient({ server, token });
  await http.presence(slug, surface);

  config.server = server;
  config.current = slug;
  config.identities[slug] = { name, token, surface };
  rememberIdentity(config, { team: slug, name, token, surface }); // ADR 059 vault
  saveConfig(config);
  // Auto-bind the joining folder so it's immediately *active* here (ADR 036): acts work without
  // `--as`, while other unbound folders stay read-only. The credential is cached globally; the
  // authority to act is this binding.
  const binding: Binding = {
    server,
    team: slug,
    member: name,
    token,
    surface: surface as Binding['surface'],
    claim: { mode: 'seat', name },
  };
  saveBinding(process.cwd(), binding);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ team: slug, member: name, surface }) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.ok('✓')} ${name} joined ${slug}\n`);
  process.stdout.write(`${theme.presenceDot('online')} ${name} online via ${surface}\n`);
  return 0;
}
