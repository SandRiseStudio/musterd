import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import { legacyUserProfilesDir, legacyUserRolesDir, userToolkitsDir } from '../onboard/profile.js';
import { toolkitCommand } from './toolkit.js';

let cwd: string;
let origCwd: string;
let out: string;

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-toolkitcmd-'));
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

describe('musterd toolkit owns workspace equipment (ADR 296)', () => {
  it('toolkit list names the built-in toolkits and never mentions team roles', () => {
    expect(toolkitCommand(parsed(['list']))).toBe(0);
    expect(out).toContain('generalist');
    expect(out).toContain('built-in');
    // The whole point of the split: this command knows nothing about the roster.
    expect(out).not.toContain('team roles');
  });

  it('toolkit list marks a user file that shadows a built-in as an override', () => {
    mkdirSync(userToolkitsDir(cwd), { recursive: true });
    writeFileSync(
      join(userToolkitsDir(cwd), 'generalist.json'),
      JSON.stringify({ toolkit: 'generalist', charter: 'mine', tools: {} }),
      'utf8',
    );
    expect(toolkitCommand(parsed(['list']))).toBe(0);
    expect(out).toContain('overrides built-in');
  });

  it('toolkit show renders a built-in toolkit', () => {
    expect(toolkitCommand(parsed(['show', 'generalist']))).toBe(0);
    expect(out).toContain('charter');
  });

  it('toolkit show --json emits the toolkit object', () => {
    expect(toolkitCommand(parsed(['show', 'generalist'], { json: true }))).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ toolkit: 'generalist' });
  });

  it('toolkit create scaffolds a workspace toolkit file', () => {
    expect(toolkitCommand(parsed(['create', 'writer']))).toBe(0);
    const path = join(userToolkitsDir(cwd), 'writer.json');
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ toolkit: 'writer' });
  });

  it('toolkit create refuses to clobber without --force', () => {
    expect(toolkitCommand(parsed(['create', 'writer']))).toBe(0);
    expect(() => toolkitCommand(parsed(['create', 'writer']))).toThrow(/--force/);
  });

  it('toolkit create rejects a name that is not a slug', () => {
    expect(() => toolkitCommand(parsed(['create', 'Not A Slug']))).toThrow(CliError);
  });

  it('toolkit create in a roster home still writes a toolkit, never a team role', () => {
    // The one-way derivation rule (ADR 296 §1.3): a local file may never assert a team
    // responsibility. Being in a roster home must not change what this command authors.
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(join(cwd, '.musterd', 'team.toml'), 'name = "revive"\n', 'utf8');
    expect(toolkitCommand(parsed(['create', 'writer']))).toBe(0);
    expect(existsSync(join(userToolkitsDir(cwd), 'writer.json'))).toBe(true);
    expect(existsSync(join(cwd, '.musterd', 'roles', 'writer.toml'))).toBe(false);
  });

  it('an unknown subcommand names the three that exist', () => {
    expect(() => toolkitCommand(parsed(['nope']))).toThrow(/create.*list.*show|list.*show.*create/);
  });
});

describe('coverage carried over from role (ADR 296 split — same behaviour, new command)', () => {
  it('lists a built-in that is not generalist', () => {
    expect(toolkitCommand(parsed(['list']))).toBe(0);
    expect(out).toContain('backend');
  });

  it('marks a legacy role-keyed file in .musterd/roles/ as user, and a same-named one as override', () => {
    mkdirSync(legacyUserRolesDir(cwd), { recursive: true });
    writeFileSync(
      join(legacyUserRolesDir(cwd), 'data.json'),
      JSON.stringify({ role: 'data', charter: 'c' }),
    );
    writeFileSync(
      join(legacyUserRolesDir(cwd), 'backend.json'),
      JSON.stringify({ role: 'backend', charter: 'mine' }),
    );
    toolkitCommand(parsed(['list'], { json: true }));
    const { toolkits } = JSON.parse(out);
    expect(toolkits).toEqual(expect.arrayContaining([{ name: 'data', origin: 'user' }]));
    expect(toolkits).toEqual(expect.arrayContaining([{ name: 'backend', origin: 'override' }]));
  });

  it('show renders a built-in with its mcp server', () => {
    expect(toolkitCommand(parsed(['show', 'backend']))).toBe(0);
    expect(out).toContain('supabase');
  });

  it('show errors with exit 4 on an unknown name', () => {
    expect(() => toolkitCommand(parsed(['show', 'nope']))).toThrow(
      expect.objectContaining({ exitCode: 4 }),
    );
  });

  it('show requires a name', () => {
    expect(() => toolkitCommand(parsed(['show']))).toThrow(CliError);
  });

  it('create --from round-trips a built-in under the new name', () => {
    expect(toolkitCommand(parsed(['create', 'mybackend'], { from: 'backend' }))).toBe(0);
    const written = JSON.parse(readFileSync(join(userToolkitsDir(cwd), 'mybackend.json'), 'utf8'));
    expect(written.toolkit).toBe('mybackend');
    expect(written.tools.mcp_servers[0].name).toBe('supabase');
  });

  it('create --force overwrites from a different built-in', () => {
    toolkitCommand(parsed(['create', 'qa']));
    expect(toolkitCommand(parsed(['create', 'qa'], { force: true, from: 'docs' }))).toBe(0);
    const written = JSON.parse(readFileSync(join(userToolkitsDir(cwd), 'qa.json'), 'utf8'));
    expect(written.tools.resource_scopes).toContain('docs/**');
  });

  it('create --from an unknown built-in is refused with exit 2, naming the valid set', () => {
    expect(() => toolkitCommand(parsed(['create', 'x'], { from: 'nope' }))).toThrow(
      expect.objectContaining({ exitCode: 2 }),
    );
  });
});

describe('toolkit origin across the legacy homes', () => {
  it('a user file in any of the three homes reads as user, never built-in', () => {
    for (const [home, key] of [
      [userToolkitsDir(cwd), 'toolkit'],
      [legacyUserProfilesDir(cwd), 'profile'],
      [legacyUserRolesDir(cwd), 'role'],
    ] as const) {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, `mine-${key}.json`),
        JSON.stringify({ [key]: `mine-${key}`, charter: 'c' }),
      );
      out = '';
      expect(toolkitCommand(parsed(['show', `mine-${key}`]))).toBe(0);
      expect(out).toContain('(user)');
      expect(out).not.toContain('(built-in)');
    }
  });
});
