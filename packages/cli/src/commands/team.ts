import type { Binding, Lifecycle, MemberKind } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig, rememberIdentity, saveBinding, saveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

export async function teamCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'create') return teamCreate(parsed);
  if (sub === 'add') return teamAdd(parsed);
  if (sub === 'remove') return teamRemove(parsed);
  throw new CliError('usage: musterd team <create|add|remove> ...', 2);
}

async function teamCreate(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[1];
  if (!slug)
    throw new CliError('usage: musterd team create <slug> [--as <you>] [--role <role>]', 2);
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
  rememberIdentity(config, { team: slug, name, token: res.token, surface: 'cli' }); // ADR 059 vault
  saveConfig(config);
  // Auto-bind the creating folder so it's immediately *active* — you can act here without `--as`,
  // while every other unbound folder stays read-only (ADR 036). The global config alone no longer
  // authorizes acting; this binding does.
  const binding: Binding = {
    server,
    team: slug,
    member: name,
    token: res.token,
    surface: 'cli',
    claim: { mode: 'seat', name },
  };
  saveBinding(process.cwd(), binding);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ team: res.team, member: res.member }) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.ok('✓')} team "${slug}" created\n`);
  process.stdout.write(
    `you are now a member: ${theme.memberName(name, 'human')} (human${role ? `, ${role}` : ''})\n`,
  );
  process.stdout.write(theme.meta('bound this folder as your seat — act here with no --as') + '\n');
  process.stdout.write(theme.meta('add members with: musterd team add <name> --kind agent') + '\n');
  return 0;
}

async function teamAdd(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  const kind = flagStr(parsed.flags, 'kind') as MemberKind | undefined;
  if (!name || (kind !== 'agent' && kind !== 'human')) {
    throw new CliError('usage: musterd team add <name> --kind <agent|human> [--role <role>]', 2);
  }
  // Adding a member is an admin act, so it needs an *active* identity (binding/env/--as), not just
  // an ambient global-config default (ADR 036). `resolve()` enforces that.
  const { team, http } = resolve(parsed.flags);

  const role = flagStr(parsed.flags, 'role');
  const lifecycle = flagStr(parsed.flags, 'lifecycle') as Lifecycle | undefined;
  const until = flagStr(parsed.flags, 'until');
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
  process.stdout.write(
    `${theme.ok('✓')} added ${theme.memberName(name, kind)} (${kind}${role ? `, ${role}` : ''}) to ${team}\n`,
  );
  if (kind === 'agent') {
    process.stdout.write(theme.meta('connect this agent via MCP with env:') + '\n');
    process.stdout.write(
      theme.meta(
        `  MUSTERD_TEAM=${team} MUSTERD_MEMBER=${name} MUSTERD_TOKEN=${res.token} MUSTERD_SURFACE=claude-code`,
      ) + '\n',
    );
    // Hand-off path (ADR 055): the agent adopts the seat in its own folder with no global-config
    // clobber — preferred over `join --token`, which overwrites this machine's cached identity.
    process.stdout.write(
      theme.meta(`or adopt it in the agent's folder: musterd claim ${name} --token ${res.token}`) +
        '\n',
    );
  } else {
    process.stdout.write(
      theme.meta(`they join with: musterd join ${team} --as ${name} --token ${res.token}`) + '\n',
    );
  }
  return 0;
}

/**
 * Soft-remove a member from a team's roster (ADR 019). The sanctioned way to clear a mistaken or
 * stale member instead of editing the daemon's DB: it sets `left_at`, so the member drops off every
 * roster/auth path while its message history + provenance survive. Idempotent — an already-removed
 * (or never-existing) member is a clean `not_found`, not an error stack.
 */
async function teamRemove(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd team remove <name>', 2);
  const { team, http } = resolve(parsed.flags);
  const res = await http.removeMember(team, name);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  process.stdout.write(
    `${theme.ok('✓')} removed ${theme.memberName(res.member, res.kind)} from ${team} — off the roster; message history is kept\n`,
  );
  return 0;
}

function defaultUser(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? 'me';
}
