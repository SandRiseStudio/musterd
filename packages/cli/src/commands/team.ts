import type { Lifecycle, MemberKind } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { loadConfig, saveConfig } from '../config.js';
import { HttpClient } from '../client.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

export async function teamCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'create') return teamCreate(parsed);
  if (sub === 'add') return teamAdd(parsed);
  throw new CliError('usage: musterd team <create|add> ...', 2);
}

async function teamCreate(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[1];
  if (!slug) throw new CliError('usage: musterd team create <slug> [--as <you>] [--role <role>]', 2);
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const name = flagStr(parsed.flags, 'as') ?? defaultUser();
  const role = flagStr(parsed.flags, 'role');
  const display = flagStr(parsed.flags, 'display');
  const http = new HttpClient({ server });
  const res = await http.createTeam(slug, { name, ...(role ? { role } : {}) }, display);

  config.server = server;
  config.current = slug;
  config.identities[slug] = { name, token: res.token, surface: 'cli' };
  saveConfig(config);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ team: res.team, member: res.member }) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.ok('✓')} team "${slug}" created\n`);
  process.stdout.write(`you are now a member: ${theme.memberName(name, 'human')} (human${role ? `, ${role}` : ''})\n`);
  process.stdout.write(theme.meta('add members with: musterd team add <name> --kind agent') + '\n');
  return 0;
}

async function teamAdd(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  const kind = flagStr(parsed.flags, 'kind') as MemberKind | undefined;
  if (!name || (kind !== 'agent' && kind !== 'human')) {
    throw new CliError('usage: musterd team add <name> --kind <agent|human> [--role <role>]', 2);
  }
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const team = flagStr(parsed.flags, 'team') ?? config.current;
  if (!team) throw new CliError('no team — run: musterd team create <name>', 2);
  const identity = config.identities[team];
  if (!identity) throw new CliError(`no identity for team "${team}"`, 4);

  const role = flagStr(parsed.flags, 'role');
  const lifecycle = flagStr(parsed.flags, 'lifecycle') as Lifecycle | undefined;
  const until = flagStr(parsed.flags, 'until');
  const http = new HttpClient({ server, token: identity.token });
  const res = await http.addMember(team, {
    name,
    kind,
    role,
    ...(lifecycle ? { lifecycle } : {}),
    ...(until ? { lifecycle_until: Date.parse(until) } : {}),
  });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ member: res.member, token: res.token }) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.ok('✓')} added ${theme.memberName(name, kind)} (${kind}${role ? `, ${role}` : ''}) to ${team}\n`);
  if (kind === 'agent') {
    process.stdout.write(theme.meta('connect this agent via MCP with env:') + '\n');
    process.stdout.write(
      theme.meta(`  MUSTERD_TEAM=${team} MUSTERD_MEMBER=${name} MUSTERD_TOKEN=${res.token} MUSTERD_SURFACE=claude-code`) + '\n',
    );
  } else {
    process.stdout.write(theme.meta(`they join with: musterd join ${team} --as ${name} --token ${res.token}`) + '\n');
  }
  return 0;
}

function defaultUser(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? 'me';
}
