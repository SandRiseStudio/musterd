import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRoleFile } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import { legacyUserRolesDir, userProfilesDir } from '../onboard/profile.js';
import { roleCommand } from './role.js';

let cwd: string;
let origCwd: string;
let out: string;

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-rolecmd-'));
  process.chdir(cwd);
  cwd = process.cwd();
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    out += String(s);
    return true;
  });
});
afterEach(() => {
  process.chdir(origCwd);
  vi.restoreAllMocks();
});

function parsed(positionals: string[], flags: Record<string, string | boolean> = {}) {
  return { positionals, flags, metaPairs: [] };
}

describe('role list/show roster-first (ADR 227 close-out)', () => {
  const roster = {
    team: 'revive',
    members: [
      { name: 'izzo', roles: ['platform'] },
      { name: 'miley', roles: ['designer'] },
    ] as any[],
    roles: [
      { name: 'designer', summary: 'Owns the design surfaces', charter: '…', capabilities: {} },
      { name: 'observer', summary: 'read-only watcher', charter: '…', capabilities: {} },
      { name: 'platform', summary: 'infra toucher', charter: 'You touch infra.', capabilities: {} },
    ],
  };

  it('role list renders the team library first when a roster is reachable', async () => {
    expect(await roleCommand(parsed(['list']), { fetchRoster: async () => roster })).toBe(0);
    expect(out.indexOf('team roles')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('team roles')).toBeLessThan(out.indexOf('workspace profiles'));
    expect(out).toContain('platform');
    expect(out).toContain('izzo');
    expect(out).toContain('(unheld)'); // observer has no holder
  });

  it('role list falls back to template-only output when no roster is reachable', async () => {
    expect(await roleCommand(parsed(['list']), { fetchRoster: async () => null })).toBe(0);
    expect(out).not.toContain('team roles');
    expect(out).toContain('built-in'); // today's output, unchanged
  });

  it('role show prefers the team role and names its holders', async () => {
    expect(
      await roleCommand(parsed(['show', 'platform']), { fetchRoster: async () => roster }),
    ).toBe(0);
    expect(out).toContain('infra toucher');
    expect(out).toContain('You touch infra.');
    expect(out).toContain('izzo');
  });

  it('role show falls through to the provisioning template when the roster has no such role', async () => {
    expect(
      await roleCommand(parsed(['show', 'backend']), { fetchRoster: async () => roster }),
    ).toBe(0);
    expect(out).toContain('built-in'); // template path, unchanged
  });
});

describe('role assign (ADR 227 — roster roles, run in the roster home)', () => {
  function writeRosterHome() {
    const m = join(cwd, '.musterd');
    mkdirSync(join(m, 'seats'), { recursive: true });
    mkdirSync(join(m, 'roles'), { recursive: true });
    writeFileSync(join(m, 'team.toml'), 'slug = "alpha"\n');
    writeFileSync(join(m, 'seats', 'izzo.toml'), 'kind = "agent"\nrole = ""\n');
    writeFileSync(
      join(m, 'roles', 'platform.toml'),
      'summary = "Designated toucher of running infrastructure"\n',
    );
    writeFileSync(join(m, 'roles', 'designer.toml'), 'summary = "Owns the design surfaces"\n');
    return m;
  }

  it('assigns a library role to a seat (single role → the bare label form)', async () => {
    const m = writeRosterHome();
    expect(await roleCommand(parsed(['assign', 'izzo', 'platform']))).toBe(0);
    expect(readFileSync(join(m, 'seats', 'izzo.toml'), 'utf8')).toBe(
      'kind = "agent"\nrole = "platform"\n',
    );
  });

  it('appends a second role, emitting the canonical roles array', async () => {
    const m = writeRosterHome();
    await roleCommand(parsed(['assign', 'izzo', 'platform']));
    expect(await roleCommand(parsed(['assign', 'izzo', 'designer']))).toBe(0);
    expect(readFileSync(join(m, 'seats', 'izzo.toml'), 'utf8')).toBe(
      'kind = "agent"\nrole = "platform"\nroles = ["platform", "designer"]\n',
    );
  });

  it('is idempotent — assigning a held role changes nothing', async () => {
    const m = writeRosterHome();
    await roleCommand(parsed(['assign', 'izzo', 'platform']));
    const before = readFileSync(join(m, 'seats', 'izzo.toml'), 'utf8');
    expect(await roleCommand(parsed(['assign', 'izzo', 'platform']))).toBe(0);
    expect(readFileSync(join(m, 'seats', 'izzo.toml'), 'utf8')).toBe(before);
  });

  it('removes a role with --remove', async () => {
    const m = writeRosterHome();
    await roleCommand(parsed(['assign', 'izzo', 'platform']));
    await roleCommand(parsed(['assign', 'izzo', 'designer']));
    expect(await roleCommand(parsed(['assign', 'izzo', 'platform'], { remove: true }))).toBe(0);
    expect(readFileSync(join(m, 'seats', 'izzo.toml'), 'utf8')).toBe(
      'kind = "agent"\nrole = "designer"\n',
    );
  });

  /**
   * ADR 261 increment 2 — the known trap: `role assign` re-roles a seat without re-provisioning,
   * so the seat keeps the ceiling of the role it no longer holds. The roster home is not the seat's
   * worktree, so the recompile has to resolve where the seat actually lives before it can write.
   */
  describe('recompiles the seat harness permissions (ADR 261 inc 2)', () => {
    function seatDir(): string {
      const ws = join(cwd, 'seat-worktree');
      mkdirSync(join(ws, '.claude'), { recursive: true });
      writeFileSync(
        join(ws, '.claude', 'settings.local.json'),
        JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }] } }),
      );
      return ws;
    }
    function readPerms(ws: string): { allow?: string[]; deny?: string[] } {
      return (
        JSON.parse(readFileSync(join(ws, '.claude', 'settings.local.json'), 'utf8')).permissions ??
        {}
      );
    }

    it("compiles the assigned role ceiling into the seat's worktree, not the roster home", async () => {
      const m = writeRosterHome();
      writeFileSync(join(m, 'roles', 'read-only.toml'), 'summary = "watcher"\n');
      const ws = seatDir();
      expect(
        await roleCommand(parsed(['assign', 'izzo', 'read-only']), { seatWorkspace: () => ws }),
      ).toBe(0);
      const perms = readPerms(ws);
      // The ceiling is deny — that is the only thing that makes it a ceiling.
      expect(perms.deny).toEqual(expect.arrayContaining(['Edit', 'Write']));
      // …and the floor rides along, so the seat can still do its (read-only) job non-interactively.
      expect(perms.allow).toContain('Read');
      // The roster home is a different folder and must not have been written.
      expect(() => readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8')).toThrow();
    });

    it('preserves the hooks already in the seat file (merge-never-clobber)', async () => {
      const m = writeRosterHome();
      writeFileSync(join(m, 'roles', 'read-only.toml'), 'summary = "watcher"\n');
      const ws = seatDir();
      await roleCommand(parsed(['assign', 'izzo', 'read-only']), { seatWorkspace: () => ws });
      const s = JSON.parse(readFileSync(join(ws, '.claude', 'settings.local.json'), 'utf8'));
      expect(s.hooks?.SessionStart).toBeDefined();
    });

    it('says so plainly when it cannot find the seat worktree, instead of silently skipping', async () => {
      const m = writeRosterHome();
      writeFileSync(join(m, 'roles', 'read-only.toml'), 'summary = "watcher"\n');
      expect(
        await roleCommand(parsed(['assign', 'izzo', 'read-only']), {
          seatWorkspace: () => undefined,
        }),
      ).toBe(0);
      // The assignment still succeeds — the roster file is the source of truth. But an un-recompiled
      // ceiling is exactly the trap, so it must be visible rather than assumed.
      expect(out).toMatch(/refresh-permissions/);
    });

    it('warns on --remove that the old ceiling stays in force until it is reversed by hand', async () => {
      const m = writeRosterHome();
      writeFileSync(join(m, 'roles', 'read-only.toml'), 'summary = "watcher"\n');
      const ws = seatDir();
      await roleCommand(parsed(['assign', 'izzo', 'read-only']), { seatWorkspace: () => ws });
      out = '';
      await roleCommand(parsed(['assign', 'izzo', 'read-only'], { remove: true }), {
        seatWorkspace: () => ws,
      });
      // The merge is additive by construction, so it cannot lift a deny. Saying nothing here would
      // leave a seat read-only after its read-only role was removed — the trap, inverted.
      expect(out).toMatch(/deny|ceiling/i);
      expect(readPerms(ws).deny).toEqual(expect.arrayContaining(['Edit']));
    });

    it('skips silently when the assigned roster role has no provisioning template', async () => {
      // `platform` is a roster label with no permission profile — there is nothing to compile, and
      // inventing a ceiling for it would be worse than doing nothing.
      const ws = seatDir();
      writeRosterHome();
      await roleCommand(parsed(['assign', 'izzo', 'platform']), { seatWorkspace: () => ws });
      expect(readPerms(ws).deny ?? []).toEqual([]);
    });
  });

  it('refuses an unknown role, naming the library (typo-guard; --force overrides)', async () => {
    const m = writeRosterHome();
    await expect(roleCommand(parsed(['assign', 'izzo', 'platfrom']))).rejects.toThrow(
      /platfrom.*designer, platform/s,
    );
    expect(await roleCommand(parsed(['assign', 'izzo', 'platfrom'], { force: true }))).toBe(0);
    expect(readFileSync(join(m, 'seats', 'izzo.toml'), 'utf8')).toContain('role = "platfrom"');
  });

  it('errors helpfully outside a roster home and on a missing seat', async () => {
    await expect(roleCommand(parsed(['assign', 'izzo', 'platform']))).rejects.toThrow(
      /roster home/,
    );
    writeRosterHome();
    await expect(roleCommand(parsed(['assign', 'ghost', 'platform']))).rejects.toThrow(/ghost/);
  });
});

describe('role list', () => {
  it('lists the built-ins, marking generalist', async () => {
    expect(await roleCommand(parsed(['list']))).toBe(0);
    expect(out).toContain('generalist');
    expect(out).toContain('backend');
    expect(out).toContain('built-in');
  });

  it('marks a user file as user, and a same-named file as an override — legacy role-keyed files in .musterd/roles/ included', async () => {
    mkdirSync(legacyUserRolesDir(cwd), { recursive: true });
    writeFileSync(
      join(legacyUserRolesDir(cwd), 'data.json'),
      JSON.stringify({ role: 'data', charter: 'c' }),
    );
    writeFileSync(
      join(legacyUserRolesDir(cwd), 'backend.json'),
      JSON.stringify({ role: 'backend', charter: 'mine' }),
    );
    await roleCommand(parsed(['list'], { json: true }));
    // Close-out shape: { team, templates } — team is null when no roster is reachable.
    const { team, templates } = JSON.parse(out);
    expect(team).toBeNull();
    expect(templates).toEqual(expect.arrayContaining([{ name: 'data', origin: 'user' }]));
    expect(templates).toEqual(expect.arrayContaining([{ name: 'backend', origin: 'override' }]));
  });
});

describe('role show', () => {
  it('shows a built-in resolved template', async () => {
    expect(await roleCommand(parsed(['show', 'backend']))).toBe(0);
    expect(out).toContain('backend');
    expect(out).toContain('supabase'); // its mcp server
    expect(out).toContain('charter');
  });

  it('emits the parsed object with --json', async () => {
    await roleCommand(parsed(['show', 'reviewer'], { json: true }));
    const role = JSON.parse(out);
    expect(role.profile).toBe('reviewer');
    expect(role.tools).toBeTruthy();
  });

  it('errors (exit 4) on an unknown role', async () => {
    await expect(roleCommand(parsed(['show', 'nope']))).rejects.toMatchObject({ exitCode: 4 });
  });

  it('requires a name', async () => {
    await expect(roleCommand(parsed(['show']))).rejects.toBeInstanceOf(CliError);
  });
});

describe('role create', () => {
  it('scaffolds a minimal skeleton at .musterd/profiles/<name>.json', async () => {
    expect(await roleCommand(parsed(['create', 'qa']))).toBe(0);
    const written = JSON.parse(readFileSync(join(userProfilesDir(cwd), 'qa.json'), 'utf8'));
    expect(written.profile).toBe('qa');
    expect(written.charter).toContain('TODO');
    expect(written.tools.mcp_servers).toEqual([]);
  });

  it('round-trips a built-in with --from, renamed to the new name', async () => {
    expect(await roleCommand(parsed(['create', 'mybackend'], { from: 'backend' }))).toBe(0);
    const written = JSON.parse(readFileSync(join(userProfilesDir(cwd), 'mybackend.json'), 'utf8'));
    expect(written.profile).toBe('mybackend'); // renamed
    expect(written.tools.mcp_servers[0].name).toBe('supabase'); // copied from backend
  });

  it('refuses to overwrite without --force, then allows it with --force', async () => {
    await roleCommand(parsed(['create', 'qa']));
    await expect(roleCommand(parsed(['create', 'qa']))).rejects.toMatchObject({ exitCode: 1 });
    expect(await roleCommand(parsed(['create', 'qa'], { force: true, from: 'docs' }))).toBe(0);
    const written = JSON.parse(readFileSync(join(userProfilesDir(cwd), 'qa.json'), 'utf8'));
    expect(written.tools.resource_scopes).toContain('docs/**'); // overwritten from docs
  });

  it('rejects an invalid name', async () => {
    await expect(roleCommand(parsed(['create', 'Bad Name']))).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it('rejects --from an unknown built-in', async () => {
    await expect(roleCommand(parsed(['create', 'x'], { from: 'nope' }))).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});

/**
 * Registry thin slice: in a roster home, `role create` authors the durable role library
 * (`.musterd/roles/<name>.toml`) — the file `role assign` validates against and the daemon
 * reconciles. Outside a roster home nothing changes: the legacy profile scaffold stays as-is
 * (its rename is the ADR 296 enforcement build's, not this slice's).
 */
describe('role create in a roster home (registry thin slice)', () => {
  function writeRosterHome() {
    const m = join(cwd, '.musterd');
    mkdirSync(join(m, 'seats'), { recursive: true });
    writeFileSync(join(m, 'team.toml'), 'slug = "alpha"\n');
    return m;
  }

  it('writes a canonical roles/<name>.toml skeleton, not a profile json', async () => {
    const m = writeRosterHome();
    expect(await roleCommand(parsed(['create', 'qa']))).toBe(0);
    const text = readFileSync(join(m, 'roles', 'qa.toml'), 'utf8');
    // Canonical serializeRole form: summary line first, charter TODO to fill in.
    expect(text).toMatch(/^summary = /);
    expect(text).toContain('TODO');
    // Round-trips through the daemon's own parser — reconcile will accept it as written.
    expect(() => parseRoleFile(text)).not.toThrow();
    // The legacy profile path must NOT have been written — this is a role, not a toolkit.
    expect(() => readFileSync(join(userProfilesDir(cwd), 'qa.json'), 'utf8')).toThrow();
  });

  it('instantiates a built-in role template with --from, structural capabilities included', async () => {
    const m = writeRosterHome();
    expect(await roleCommand(parsed(['create', 'watcher'], { from: 'observer' }))).toBe(0);
    const role = parseRoleFile(readFileSync(join(m, 'roles', 'watcher.toml'), 'utf8'));
    expect(role.summary).toMatch(/read-only/i);
    // Observer's capabilities are structural — the template must carry them or the role is a label.
    expect(role.capabilities.can_message).toBe('none');
    expect(role.capabilities.can_flag_urgent).toBe(false);
  });

  it('carries is_admin on the admin template — the ADR 172 clamp depends on roles being the carrier', async () => {
    const m = writeRosterHome();
    expect(await roleCommand(parsed(['create', 'admin'], { from: 'admin' }))).toBe(0);
    const role = parseRoleFile(readFileSync(join(m, 'roles', 'admin.toml'), 'utf8'));
    expect(role.capabilities.is_admin).toBe(true);
  });

  it('refuses to overwrite an existing role file without --force', async () => {
    const m = writeRosterHome();
    await roleCommand(parsed(['create', 'qa']));
    await expect(roleCommand(parsed(['create', 'qa']))).rejects.toMatchObject({ exitCode: 1 });
    expect(await roleCommand(parsed(['create', 'qa'], { force: true, from: 'observer' }))).toBe(0);
    const role = parseRoleFile(readFileSync(join(m, 'roles', 'qa.toml'), 'utf8'));
    expect(role.capabilities.can_message).toBe('none'); // overwritten from the template
  });

  it('rejects --from an unknown role template, naming the valid set', async () => {
    writeRosterHome();
    await expect(roleCommand(parsed(['create', 'x'], { from: 'nope' }))).rejects.toThrow(
      /observer/,
    );
  });

  it('keeps the legacy profile scaffold reachable in a roster home via --profile', async () => {
    writeRosterHome();
    expect(await roleCommand(parsed(['create', 'qa'], { profile: true }))).toBe(0);
    const written = JSON.parse(readFileSync(join(userProfilesDir(cwd), 'qa.json'), 'utf8'));
    expect(written.profile).toBe('qa');
    expect(() => readFileSync(join(cwd, '.musterd', 'roles', 'qa.toml'), 'utf8')).toThrow();
  });

  it('points at assign + commit as the next step — the file is the single writer', async () => {
    writeRosterHome();
    await roleCommand(parsed(['create', 'qa']));
    expect(out).toMatch(/role assign/);
    expect(out).toMatch(/commit/i);
  });
});

describe('role dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    await expect(roleCommand(parsed(['bogus']))).rejects.toBeInstanceOf(CliError);
  });
});
