import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSeatFile, seatNameFromPath, seatRoles, serializeSeat } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { installSeatPermissions } from '../onboard/permissions.js';
import {
  BUILTIN_PROFILES,
  GENERALIST,
  isBuiltin,
  legacyUserRolesDir,
  listProfileNames,
  loadProfile,
  userProfilesDir,
  type Profile,
} from '../onboard/profile.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import { resolveRead } from './helpers.js';

/**
 * Two worlds under one name (ADR 227 close-out; ADR 272 names them). `list`/`show` are
 * **roster-first**: they render the team's durable role library (`roles/<name>.toml`, read off the
 * daemon roster) above the local **workspace profiles** (the ADR 026 provisioning templates,
 * renamed), and degrade to profile-only output when no team is reachable (unbound folder, daemon
 * down, older daemon) — the read path never hard-fails. `create` scaffolds a profile; `assign`
 * edits the roster (see its doc below).
 */

/** The roster read `list`/`show` render from — injectable so tests need no daemon. */
export interface RosterRead {
  team: string;
  members: Array<{ name: string; roles?: string[] }>;
  roles: Array<{
    name: string;
    summary: string | null;
    charter?: string | null;
    capabilities?: unknown;
  }>;
}
export interface RoleDeps {
  fetchRoster?: (flags: Parsed['flags']) => Promise<RosterRead | null>;
  /** Where a seat's worktree lives (ADR 261 inc 2) — injectable so tests need no global registry. */
  seatWorkspace?: (seat: string) => string | undefined;
}

/**
 * Resolve a seat's worktree from the global bindings registry (ADR 020), which is the only index
 * of where a seat is bound — the roster home holds the seat *file*, never the seat's folder.
 */
function defaultSeatWorkspace(seat: string): string | undefined {
  try {
    const { bindings } = loadConfig();
    for (const [dir, ref] of Object.entries(bindings)) {
      if (ref.seat === seat && existsSync(dir)) return dir;
    }
  } catch {
    // No readable config — the recompile is skipped and said out loud by the caller.
  }
  return undefined;
}

async function defaultFetchRoster(flags: Parsed['flags']): Promise<RosterRead | null> {
  try {
    const { team, http } = resolveRead(flags); // the status-command read path — auth-free
    const res = await http.roster(team);
    if (!res.roles) return null; // older daemon: no library on the wire — template-only output
    return { team, members: res.members, roles: res.roles };
  } catch {
    return null; // unbound folder / daemon unreachable — degrade, never fail the read
  }
}

export async function roleCommand(parsed: Parsed, deps: RoleDeps = {}): Promise<number> {
  const fetchRoster = deps.fetchRoster ?? defaultFetchRoster;
  const sub = parsed.positionals[0];
  if (sub === 'list') return roleList(parsed, await fetchRoster(parsed.flags));
  if (sub === 'show') return roleShow(parsed, await fetchRoster(parsed.flags));
  if (sub === 'create') return roleCreate(parsed);
  if (sub === 'assign') return roleAssign(parsed, deps.seatWorkspace ?? defaultSeatWorkspace);
  throw new CliError('usage: musterd role <list|show|create|assign> ...', 2);
}

/** Seats holding `name` on this roster — the "who is platform?" half of discovery. */
function holdersOf(roster: RosterRead, name: string): string[] {
  return roster.members.filter((m) => (m.roles ?? []).includes(name)).map((m) => m.name);
}

/**
 * Assign (or `--remove`) a **roster role** on a seat (ADR 227) — the durable `roles/<name>.toml`
 * kind, not the provisioning templates the other subcommands manage. Runs in the roster home
 * (the checkout holding `.musterd/team.toml`): edits `seats/<seat>.toml` canonically and leaves the
 * commit to the operator — the file is the single writer (ADR 058); the daemon reconciles on merge.
 * An unknown role is refused with the library named (a typo-guard, not enforcement — `--force`
 * writes it anyway and reconcile will warn).
 */
async function roleAssign(
  parsed: Parsed,
  seatWorkspace: (seat: string) => string | undefined,
): Promise<number> {
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

  const recompile = recompileSeatPermissions(seatName, roleName, remove, seatWorkspace);

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({ seat: seatName, roles: next, permissions: recompile.json }) + '\n',
    );
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
  for (const line of recompile.lines) process.stdout.write(`${line}\n`);
  return 0;
}

/**
 * ADR 261 increment 2 — recompile the seat's harness permission block when its role changes.
 *
 * THE TRAP THIS CLOSES: `role assign` re-roles a seat by editing the roster file and stops there,
 * so the seat kept whatever ceiling its previous role compiled. A ceiling that no longer matches
 * the role is worse than none — it is the ADR 261 incident with the blame pointing at the role
 * label instead of the settings file.
 *
 * Two truths make this necessarily partial, and both are reported rather than papered over:
 *
 *  - **The roster home is not the seat's worktree.** The seat's folder comes from the bindings
 *    registry; a seat with no binding on this machine cannot be recompiled from here at all.
 *  - **The merge is additive, so it cannot lift a `deny`.** Removing a role therefore leaves its
 *    ceiling in force. Exact reversal is the ADR 030 manifest's job and is not wired to this path
 *    yet, so `--remove` says so instead of implying a lifted ceiling.
 *
 * A roster role with no provisioning template of the same name has no profile to compile — the
 * common case (`platform`, `designer` are labels, not ceilings) — and is silently skipped, because
 * inventing a ceiling for a label would be worse than doing nothing.
 */
function recompileSeatPermissions(
  seatName: string,
  roleName: string,
  remove: boolean,
  seatWorkspace: (seat: string) => string | undefined,
): { lines: string[]; json: string } {
  let template: Profile | undefined;
  try {
    template = loadProfile(process.cwd(), roleName);
  } catch {
    return { lines: [], json: 'no-template' }; // a roster label with no profile — nothing to compile
  }
  const perms = template.tools.permissions;
  if (perms.allow.length + perms.ask.length + perms.deny.length === 0) {
    return { lines: [], json: 'no-template' };
  }

  const ws = seatWorkspace(seatName);
  if (!ws) {
    return {
      lines: [
        `  ${theme.meta(`no worktree for ${seatName} on this machine, so its harness permissions were NOT recompiled — the ceiling it had before is still in force. In that seat's folder: \`musterd init --refresh-permissions\` (ADR 261).`)}`,
      ],
      json: 'unresolved-workspace',
    };
  }
  if (remove) {
    return {
      lines: [
        `  ${theme.meta(`${roleName}'s deny entries are still in ${join(ws, '.claude', 'settings.local.json')} — the merge is additive and cannot lift a ceiling. Remove them by hand if the seat should regain what they denied.`)}`,
      ],
      json: 'ceiling-retained',
    };
  }
  const added = installSeatPermissions(ws, template);
  const count = added.allow.length + added.ask.length + added.deny.length;
  return {
    lines:
      count === 0
        ? []
        : [
            `  ${theme.meta(`recompiled ${seatName}'s harness permissions (+${String(count)}) into ${join(ws, '.claude', 'settings.local.json')}`)}`,
          ],
    json: count === 0 ? 'already-current' : 'recompiled',
  };
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

function roleList(parsed: Parsed, roster: RosterRead | null): number {
  const dir = process.cwd();
  const names = listProfileNames(dir);
  // A name is user-authored when a `.musterd/profiles/<name>.json` (or a legacy
  // `.musterd/roles/<name>.json`) exists; a user file that shadows a built-in is an *override*
  // (loadProfile prefers the file).
  const rows = names.map((name) => {
    const userFile =
      existsSync(join(userProfilesDir(dir), `${name}.json`)) ||
      existsSync(join(legacyUserRolesDir(dir), `${name}.json`));
    const origin = userFile ? (isBuiltin(name) ? 'override' : 'user') : 'built-in';
    return { name, origin };
  });

  if (parsed.flags['json']) {
    // Shape change (close-out): { team, templates } — was a bare template array.
    process.stdout.write(
      JSON.stringify({
        team: roster
          ? {
              team: roster.team,
              roles: roster.roles.map((r) => ({
                name: r.name,
                summary: r.summary,
                holders: holdersOf(roster, r.name),
              })),
            }
          : null,
        templates: rows,
      }) + '\n',
    );
    return 0;
  }
  if (roster) {
    process.stdout.write(`${theme.accent('team roles')} ${theme.meta(`(${roster.team})`)}\n`);
    for (const role of roster.roles) {
      const holders = holdersOf(roster, role.name);
      const held = holders.length ? holders.join(', ') : theme.meta('(unheld)');
      process.stdout.write(
        `  ${theme.meta(sym.bullet)} ${theme.accent(role.name)} — ${held}` +
          (role.summary ? `  ${theme.meta(role.summary)}` : '') +
          '\n',
      );
    }
    process.stdout.write(
      theme.meta('assign with: musterd role assign <seat> <role> (run in the roster home)') +
        '\n\n',
    );
    process.stdout.write(`${theme.accent('workspace profiles')} ${theme.meta('(local)')}\n`);
  } else {
    process.stdout.write(`${theme.accent('workspace profiles')} ${theme.meta(`(in ${dir})`)}\n`);
  }
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

function roleShow(parsed: Parsed, roster: RosterRead | null): number {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd role show <name>', 2);

  // Roster-first (close-out): a team-role match wins; the template renders only when no team role
  // carries the name (or no roster is reachable).
  const teamRole = roster?.roles.find((r) => r.name === name);
  if (roster && teamRole) {
    const holders = holdersOf(roster, name);
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify({ ...teamRole, holders }, null, 2) + '\n');
      return 0;
    }
    process.stdout.write(
      `${theme.accent(teamRole.name)} ${theme.meta(`(team role, ${roster.team})`)}\n`,
    );
    if (teamRole.summary) process.stdout.write(`  ${teamRole.summary}\n`);
    process.stdout.write(
      `  holders: ${holders.length ? holders.join(', ') : theme.meta('(unheld)')}\n`,
    );
    if (teamRole.charter) process.stdout.write(`  charter:\n${indent(teamRole.charter, 4)}\n`);
    const caps = teamRole.capabilities;
    if (caps && typeof caps === 'object' && Object.keys(caps as object).length) {
      process.stdout.write(`  capability defaults: ${JSON.stringify(caps)}\n`);
    }
    if (listProfileNames(process.cwd()).includes(name)) {
      process.stdout.write(
        theme.meta(
          '  a workspace profile also has this name — show is roster-first; the profile renders when no team role matches',
        ) + '\n',
      );
    }
    return 0;
  }

  let role: Profile;
  try {
    role = loadProfile(process.cwd(), name);
  } catch (err) {
    throw new CliError((err as Error).message, 4);
  }

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(role, null, 2) + '\n');
    return 0;
  }
  const overrides =
    isBuiltin(name) &&
    (existsSync(join(userProfilesDir(process.cwd()), `${name}.json`)) ||
      existsSync(join(legacyUserRolesDir(process.cwd()), `${name}.json`)));
  process.stdout.write(
    `${theme.accent(role.profile)} ${theme.meta(overrides ? '(user file, overrides the built-in)' : isBuiltin(name) ? '(built-in)' : '(user)')}\n`,
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
  const path = join(userProfilesDir(dir), `${name}.json`);
  if (existsSync(path) && !parsed.flags['force']) {
    throw new CliError(`${path} already exists — pass --force to overwrite`, 1);
  }

  const from = typeof parsed.flags['from'] === 'string' ? parsed.flags['from'] : undefined;
  const template = from ? fromBuiltin(from, name) : skeleton(name);

  mkdirSync(userProfilesDir(dir), { recursive: true });
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
 * already-validated built-in profile, renamed to `<name>` so a customized copy is distinct.
 */
function fromBuiltin(from: string, name: string): Profile {
  const base = BUILTIN_PROFILES[from];
  if (!base) {
    throw new CliError(
      `unknown built-in "${from}" — one of: ${Object.keys(BUILTIN_PROFILES).join(', ')}`,
      2,
    );
  }
  return { ...structuredClone(base), profile: name };
}

/** A minimal valid profile to fill in (charter is required; tools default empty). */
function skeleton(name: string): Profile {
  return {
    profile: name,
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
