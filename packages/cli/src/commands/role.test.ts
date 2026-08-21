import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRoleFile } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import { userProfilesDir } from '../onboard/profile.js';
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

  it('role list renders the team library when a roster is reachable', async () => {
    expect(await roleCommand(parsed(['list']), { fetchRoster: async () => roster })).toBe(0);
    expect(out).toContain('team roles');
    expect(out).toContain('platform');
    expect(out).toContain('izzo');
    expect(out).toContain('(unheld)'); // observer has no holder
  });

  it('role show prefers the team role and names its holders', async () => {
    expect(
      await roleCommand(parsed(['show', 'platform']), { fetchRoster: async () => roster }),
    ).toBe(0);
    expect(out).toContain('infra toucher');
    expect(out).toContain('You touch infra.');
    expect(out).toContain('izzo');
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

describe('role is roster-only after the toolkit split (ADR 296)', () => {
  const roster = {
    team: 'revive',
    members: [{ name: 'izzo', roles: ['platform'] }] as any[],
    roles: [
      { name: 'platform', summary: 'infra toucher', charter: 'You touch infra.', capabilities: {} },
    ],
  };

  it('role list renders the team library and no longer lists workspace equipment', async () => {
    expect(await roleCommand(parsed(['list']), { fetchRoster: async () => roster })).toBe(0);
    expect(out).toContain('team roles');
    expect(out).toContain('platform');
    // The seam ADR 296 closes: one command, one world.
    expect(out).not.toContain('workspace profiles');
    expect(out).not.toContain('workspace toolkits');
  });

  it('role list points at toolkit list rather than silently rendering toolkits', async () => {
    expect(await roleCommand(parsed(['list']), { fetchRoster: async () => roster })).toBe(0);
    expect(out).toContain('musterd toolkit list');
  });

  it('role list says the roster is unreachable instead of falling back to toolkits', async () => {
    expect(await roleCommand(parsed(['list']), { fetchRoster: async () => null })).toBe(0);
    expect(out).not.toContain('built-in');
    expect(out).toContain('musterd toolkit list');
  });

  it('role show on a name that is only a toolkit points at toolkit show, not renders it', async () => {
    mkdirSync(userProfilesDir(cwd), { recursive: true });
    writeFileSync(
      join(userProfilesDir(cwd), 'writer.json'),
      JSON.stringify({ profile: 'writer', charter: 'writes', tools: {} }),
      'utf8',
    );
    await expect(
      roleCommand(parsed(['show', 'writer']), { fetchRoster: async () => roster }),
    ).rejects.toThrow(/musterd toolkit show writer/);
  });

  it('role create outside a roster home refuses and names the command that does equip a workspace', async () => {
    await expect(roleCommand(parsed(['create', 'writer']))).rejects.toThrow(
      /musterd toolkit create/,
    );
  });

  it('role create --profile still scaffolds a workspace toolkit (quiet alias, no flag day)', async () => {
    expect(await roleCommand(parsed(['create', 'writer'], { profile: true }))).toBe(0);
    expect(existsSync(join(userProfilesDir(cwd), 'writer.json'))).toBe(true);
  });

  it('role create in a roster home authors a team role and prints the one-release pointer', async () => {
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(join(cwd, '.musterd', 'team.toml'), 'name = "revive"\n', 'utf8');
    expect(await roleCommand(parsed(['create', 'writer']))).toBe(0);
    expect(existsSync(join(cwd, '.musterd', 'roles', 'writer.toml'))).toBe(true);
    expect(out).toContain('musterd toolkit create');
  });
});
