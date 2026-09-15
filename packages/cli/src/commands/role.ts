import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSeatFile,
  type RoleFile,
  seatNameFromPath,
  seatRoles,
  serializeRole,
  serializeSeat,
} from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { installSeatPermissions } from '../onboard/permissions.js';
import { isBuiltin, loadToolkit, toolkitHomes, type Toolkit } from '../onboard/toolkit.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import { BUILTIN_ROLE_TEMPLATES, listRoleTemplateNames } from '../roster-roles/templates.js';
import { resolveRead } from './helpers.js';
import { toolkitCreate } from './toolkit.js';

/** The command that owns workspace equipment now — named once, so the pointers cannot drift. */
const TOOLKIT_LIST = 'musterd toolkit list';
const TOOLKIT_CREATE = 'musterd toolkit create';

/**
 * **The team's role library, and nothing else** (ADR 227; narrowed by ADR 296). `list`/`show`
 * render the durable `roles/<name>.toml` read off the daemon roster; `create` authors one in a
 * roster home; `assign` grants it to a seat. Workspace equipment moved to `musterd toolkit` —
 * this command used to render both worlds under one name, which is the seam ADR 296 closed.
 * Derivation flows one way: a role may name a default toolkit; a toolkit may never assert a role.
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
    // Takes the no-reclaim default even though `role list`/`show` are interactive, unlike the other
    // interactive reads — deliberately, and NOT an oversight to "restore consistency" later. The
    // opt-in exists so a genuinely interactive read fails CLOSED on a stale lease instead of
    // flapping the seat; this read cannot fail either way. `GET /teams/:slug/members` authenticates
    // through the server's `tryAuth`, which swallows a bad lease and downgrades the viewer to
    // anonymous, and an anonymous roster still carries every seat's `roles` plus the whole role
    // library — only other seats' member `capabilities` are withheld, which nothing here reads.
    // So the flag would protect nothing and cost a full WS claim on every invocation.
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
 * kind, which since ADR 296 is the only kind this command knows. Runs in the roster home
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
 * A roster role with no provisioning template of the same name has no toolkit to compile — the
 * common case (`platform`, `designer` are labels, not ceilings) — and is silently skipped, because
 * inventing a ceiling for a label would be worse than doing nothing.
 */
function recompileSeatPermissions(
  seatName: string,
  roleName: string,
  remove: boolean,
  seatWorkspace: (seat: string) => string | undefined,
): { lines: string[]; json: string } {
  let template: Toolkit | undefined;
  try {
    template = loadToolkit(process.cwd(), roleName);
  } catch {
    return { lines: [], json: 'no-template' }; // a roster label with no toolkit — nothing to compile
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
  if (parsed.flags['json']) {
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
      }) + '\n',
    );
    return 0;
  }
  if (!roster) {
    // No silent fallback to workspace equipment: an unreachable roster is a fact worth saying,
    // not a reason to render a different world under this command's name (ADR 296).
    process.stdout.write(
      theme.meta('no roster reachable — bind this folder to a team, or run the daemon') + '\n',
    );
    process.stdout.write(theme.meta(`workspace equipment lives in: ${TOOLKIT_LIST}`) + '\n');
    return 0;
  }
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
    theme.meta('assign with: musterd role assign <seat> <role> (run in the roster home)') + '\n',
  );
  process.stdout.write(theme.meta(`workspace equipment lives in: ${TOOLKIT_LIST}`) + '\n');
  return 0;
}

function roleShow(parsed: Parsed, roster: RosterRead | null): number {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd role show <name>', 2);

  const teamRole = roster?.roles.find((r) => r.name === name);
  if (!teamRole) {
    // Roster-only (ADR 296). A name that is only workspace equipment is not silently rendered
    // here under the word "role" — the command that owns it is named instead.
    const equipped =
      toolkitHomes(process.cwd()).some((home) => existsSync(join(home, `${name}.json`))) ||
      isBuiltin(name);
    const hint = equipped
      ? ` — it is a workspace toolkit: musterd toolkit show ${name}`
      : `; workspace equipment: musterd toolkit show ${name}`;
    throw new CliError(
      roster
        ? `no team role "${name}" in ${roster.team}${hint}`
        : `no roster reachable, so no team role can be resolved${hint}`,
      4,
    );
  }

  const holders = holdersOf(roster as RosterRead, name);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ ...teamRole, holders }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(
    `${theme.accent(teamRole.name)} ${theme.meta(`(team role, ${(roster as RosterRead).team})`)}\n`,
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
  return 0;
}

function roleCreate(parsed: Parsed): number {
  const name = parsed.positionals[1];
  if (!name)
    throw new CliError('usage: musterd role create <name> [--from <template>] [--force]', 2);

  // `--profile` survives as a quiet alias for one release (ADR 296) — the same scaffold, under
  // the command that now owns it. No flag day.
  if (parsed.flags['profile']) return toolkitCreate(parsed);

  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new CliError(`invalid role name "${name}" — use lowercase letters, numbers, hyphens`, 2);
  }
  const dir = process.cwd();
  if (!existsSync(join(dir, '.musterd', 'team.toml'))) {
    // Roster-only. Outside a roster home there is no team to grant a responsibility, and a local
    // file may never assert one (ADR 296 §1.3, the pre-ADR-272 defect) — so this is refused
    // rather than quietly downgraded to workspace equipment, which is what it used to do.
    throw new CliError(
      `no roster home here (.musterd/team.toml not found) — a role is a team fact, so it cannot ` +
        `be authored from an unbound folder. To equip this workspace instead: ${TOOLKIT_CREATE} ${name}`,
      2,
    );
  }
  return createRosterRole(dir, name, parsed);
}

/**
 * Author a `roles/<name>.toml` in this roster home — canonical from birth (serializeRole, same as
 * every other durable file) so `musterd fmt` has nothing to renormalize and reconcile accepts it
 * as written. The file is the single writer (ADR 058): the commit stays with the operator, and the
 * daemon projects the role on merge, exactly as with a hand-written file.
 */
function createRosterRole(dir: string, name: string, parsed: Parsed): number {
  const rolesDir = join(dir, '.musterd', 'roles');
  const path = join(rolesDir, `${name}.toml`);
  if (existsSync(path) && !parsed.flags['force']) {
    throw new CliError(`${path} already exists — pass --force to overwrite`, 1);
  }

  const from = typeof parsed.flags['from'] === 'string' ? parsed.flags['from'] : undefined;
  let role: RoleFile;
  if (from) {
    const template = BUILTIN_ROLE_TEMPLATES[from];
    if (!template) {
      throw new CliError(
        `unknown role template "${from}" — one of: ${listRoleTemplateNames().join(', ')}`,
        2,
      );
    }
    role = structuredClone(template);
  } else {
    role = {
      summary: `TODO: one line the roster surfaces for ${name}.`,
      charter: `TODO: one or two lines of lens-not-résumé charter for ${name}.`,
      capabilities: {},
    };
  }

  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(path, serializeRole(role), 'utf8');

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ path, from: from ?? null, kind: 'team-role' }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`wrote ${theme.accent(path)}${from ? theme.meta(` (from template "${from}")`) : ''}`, {
      next: `edit it, then musterd role assign <seat> ${name}`,
    }) + '\n',
  );
  process.stdout.write(
    theme.meta('commit both files — the daemon reconciles the roster on merge (ADR 058)') + '\n',
  );
  // One-release pointer (ADR 296): this command used to scaffold workspace equipment too, so
  // anyone whose muscle memory lands here for a toolkit gets told where it went. Drop it once
  // the alias goes.
  process.stdout.write(
    theme.meta(`equipping a workspace instead? that is ${TOOLKIT_CREATE} ${name}`) + '\n',
  );
  return 0;
}

/**
 * Round-trip a built-in into an editable starting point (recipe "Settled vs open"). Serializes the
 * already-validated built-in toolkit, renamed to `<name>` so a customized copy is distinct.
 */

/** A minimal valid toolkit to fill in (charter is required; tools default empty). */

function indent(text: string, n: number): string {
  const pad = ' '.repeat(n);
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
