import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSeatFile, seatNameFromPath, seatRoles, serializeSeat } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import {
  BUILTIN_ROLES,
  GENERALIST,
  isBuiltin,
  listRoleNames,
  loadRole,
  userRolesDir,
  type RoleTemplate,
} from '../onboard/role.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';

/**
 * Manage role *provisioning templates* (ADR 026 / docs/design/provisioning-recipe.md §3) from the
 * CLI: see what built-ins ship, inspect a resolved template, and scaffold an editable user template
 * in `.musterd/roles/*.json`. Pure local file + the in-source built-in library — it never touches the
 * daemon or the server roster (Universe-2 only; identity is unchanged).
 */
export async function roleCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'list') return roleList(parsed);
  if (sub === 'show') return roleShow(parsed);
  if (sub === 'create') return roleCreate(parsed);
  if (sub === 'assign') return roleAssign(parsed);
  throw new CliError('usage: musterd role <list|show|create|assign> ...', 2);
}

/**
 * Assign (or `--remove`) a **roster role** on a seat (ADR 227) — the durable `roles/<name>.toml`
 * kind, not the provisioning templates the other subcommands manage. Runs in the roster home
 * (the checkout holding `.musterd/team.toml`): edits `seats/<seat>.toml` canonically and leaves the
 * commit to the operator — the file is the single writer (ADR 058); the daemon reconciles on merge.
 * An unknown role is refused with the library named (a typo-guard, not enforcement — `--force`
 * writes it anyway and reconcile will warn).
 */
async function roleAssign(parsed: Parsed): Promise<number> {
  const seatName = parsed.positionals[1];
  const roleName = parsed.positionals[2];
  if (!seatName || !roleName) {
    throw new CliError('usage: musterd role assign <seat> <role> [--remove] [--force]', 2);
  }
  const home = process.cwd();
  const musterdDir = join(home, '.musterd');
  if (!existsSync(join(musterdDir, 'team.toml'))) {
    throw new CliError(
      `${home} is not a roster home (no .musterd/team.toml) — run this in the checkout that holds the durable roster`,
      2,
    );
  }
  const seatPath = join(musterdDir, 'seats', `${seatName}.toml`);
  if (!existsSync(seatPath)) {
    throw new CliError(`no seat "${seatName}" — no ${seatPath}`, 4);
  }

  const remove = Boolean(parsed.flags['remove']);
  if (!remove && !parsed.flags['force']) {
    const library = listRosterRoles(musterdDir);
    if (!library.includes(roleName)) {
      throw new CliError(
        `unknown role "${roleName}" — this team's roles/: ${library.length ? library.join(', ') : '(none)'}` +
          `\ncreate .musterd/roles/${roleName}.toml first, or pass --force to write the label anyway`,
        4,
      );
    }
  }

  const seat = parseSeatFile(readFileSync(seatPath, 'utf8'), seatName);
  const held = seatRoles(seat);
  const next = remove ? held.filter((r) => r !== roleName) : [...new Set([...held, roleName])];
  const roles = next.length ? next : undefined;
  const body = { ...seat, role: next[0] ?? '', ...(roles ? { roles } : {}) };
  if (!roles) delete (body as { roles?: string[] }).roles;
  writeFileSync(seatPath, serializeSeat(body), 'utf8');

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ seat: seatName, roles: next }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(
      remove
        ? `removed ${theme.accent(roleName)} from ${theme.accent(seatName)}${next.length ? ` (still: ${next.join(', ')})` : ' (now roleless — the generalist)'}`
        : `${theme.accent(seatName)} now holds ${theme.accent(next.join(', '))}`,
      { next: 'commit the seat file — the daemon reconciles on merge' },
    ) + '\n',
  );
  return 0;
}

/** The durable roster-role library: `.musterd/roles/*.toml` stems, sorted. */
function listRosterRoles(musterdDir: string): string[] {
  try {
    return readdirSync(join(musterdDir, 'roles'))
      .filter((f) => f.toLowerCase().endsWith('.toml'))
      .map((f) => seatNameFromPath(f))
      .sort();
  } catch {
    return [];
  }
}

function roleList(parsed: Parsed): number {
  const dir = process.cwd();
  const names = listRoleNames(dir);
  // A name is user-authored when a `.musterd/roles/<name>.json` exists; a user file that shadows a
  // built-in is an *override* (loadRole prefers the file).
  const rows = names.map((name) => {
    const userFile = existsSync(join(userRolesDir(dir), `${name}.json`));
    const origin = userFile ? (isBuiltin(name) ? 'override' : 'user') : 'built-in';
    return { name, origin };
  });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(rows) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.accent('roles')} ${theme.meta(`(in ${dir})`)}\n`);
  for (const { name, origin } of rows) {
    const tag =
      origin === 'built-in'
        ? theme.meta('built-in')
        : origin === 'override'
          ? theme.accent('overrides built-in')
          : theme.ok('user');
    const note = name === GENERALIST ? theme.meta(' — nothing extra') : '';
    process.stdout.write(`  ${theme.meta(sym.bullet)} ${name}  ${tag}${note}\n`);
  }
  process.stdout.write(
    theme.meta(
      `inspect with: musterd role show <name>   ${sym.dot}   scaffold: musterd role create <name>`,
    ) + '\n',
  );
  return 0;
}

function roleShow(parsed: Parsed): number {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd role show <name>', 2);
  let role: RoleTemplate;
  try {
    role = loadRole(process.cwd(), name);
  } catch (err) {
    throw new CliError((err as Error).message, 4);
  }

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(role, null, 2) + '\n');
    return 0;
  }
  const overrides =
    isBuiltin(name) && existsSync(join(userRolesDir(process.cwd()), `${name}.json`));
  process.stdout.write(
    `${theme.accent(role.role)} ${theme.meta(overrides ? '(user file, overrides the built-in)' : isBuiltin(name) ? '(built-in)' : '(user)')}\n`,
  );
  if (role.capacity) process.stdout.write(`  capacity: ${role.capacity}\n`);
  process.stdout.write(`  charter:\n${indent(role.charter, 4)}\n`);
  const { mcp_servers, resource_scopes, permissions } = role.tools;
  process.stdout.write(
    `  mcp servers: ${mcp_servers.length ? mcp_servers.map((s) => s.name).join(', ') : theme.meta('none')}\n`,
  );
  process.stdout.write(
    `  resource scopes: ${resource_scopes.length ? resource_scopes.join(', ') : theme.meta('none')} ${theme.meta('(declared — coordination, not a sandbox)')}\n`,
  );
  const permParts = (['allow', 'ask', 'deny'] as const)
    .filter((k) => permissions[k].length)
    .map((k) => `${k}=[${permissions[k].join(', ')}]`);
  process.stdout.write(
    `  permissions: ${permParts.length ? permParts.join('  ') : theme.meta('none')}\n`,
  );
  return 0;
}

function roleCreate(parsed: Parsed): number {
  const name = parsed.positionals[1];
  if (!name)
    throw new CliError('usage: musterd role create <name> [--from <builtin>] [--force]', 2);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new CliError(`invalid role name "${name}" — use lowercase letters, numbers, hyphens`, 2);
  }
  const dir = process.cwd();
  const path = join(userRolesDir(dir), `${name}.json`);
  if (existsSync(path) && !parsed.flags['force']) {
    throw new CliError(`${path} already exists — pass --force to overwrite`, 1);
  }

  const from = typeof parsed.flags['from'] === 'string' ? parsed.flags['from'] : undefined;
  const template = from ? fromBuiltin(from, name) : skeleton(name);

  mkdirSync(userRolesDir(dir), { recursive: true });
  writeFileSync(path, JSON.stringify(template, null, 2) + '\n', 'utf8');

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ path, from: from ?? null }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`wrote ${theme.accent(path)}${from ? theme.meta(` (from built-in "${from}")`) : ''}`, {
      next: 'musterd init',
    }) + '\n',
  );
  process.stdout.write(
    theme.meta(
      'edit it, then provision it via `musterd init` (it overrides a built-in of the same name)',
    ) + '\n',
  );
  return 0;
}

/**
 * Round-trip a built-in into an editable starting point (recipe "Settled vs open"). Serializes the
 * already-validated built-in template, renamed to `<name>` so a customized copy is distinct.
 */
function fromBuiltin(from: string, name: string): RoleTemplate {
  const base = BUILTIN_ROLES[from];
  if (!base) {
    throw new CliError(
      `unknown built-in "${from}" — one of: ${Object.keys(BUILTIN_ROLES).join(', ')}`,
      2,
    );
  }
  return { ...structuredClone(base), role: name };
}

/** A minimal valid template to fill in (charter is required; tools default empty). */
function skeleton(name: string): RoleTemplate {
  return {
    role: name,
    charter: `TODO: one or two lines of lens-not-résumé charter for ${name}.`,
    tools: {
      mcp_servers: [],
      resource_scopes: [],
      permissions: { allow: [], ask: [], deny: [] },
    },
  };
}

function indent(text: string, n: number): string {
  const pad = ' '.repeat(n);
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
