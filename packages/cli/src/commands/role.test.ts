import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import { userRolesDir } from '../onboard/role.js';
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

describe('role list', () => {
  it('lists the built-ins, marking generalist', async () => {
    expect(await roleCommand(parsed(['list']))).toBe(0);
    expect(out).toContain('generalist');
    expect(out).toContain('backend');
    expect(out).toContain('built-in');
  });

  it('marks a user file as user, and a same-named file as an override', async () => {
    mkdirSync(userRolesDir(cwd), { recursive: true });
    writeFileSync(
      join(userRolesDir(cwd), 'data.json'),
      JSON.stringify({ role: 'data', charter: 'c' }),
    );
    writeFileSync(
      join(userRolesDir(cwd), 'backend.json'),
      JSON.stringify({ role: 'backend', charter: 'mine' }),
    );
    await roleCommand(parsed(['list'], { json: true }));
    const rows = JSON.parse(out);
    expect(rows).toEqual(expect.arrayContaining([{ name: 'data', origin: 'user' }]));
    expect(rows).toEqual(expect.arrayContaining([{ name: 'backend', origin: 'override' }]));
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
    expect(role.role).toBe('reviewer');
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
  it('scaffolds a minimal skeleton at .musterd/roles/<name>.json', async () => {
    expect(await roleCommand(parsed(['create', 'qa']))).toBe(0);
    const written = JSON.parse(readFileSync(join(userRolesDir(cwd), 'qa.json'), 'utf8'));
    expect(written.role).toBe('qa');
    expect(written.charter).toContain('TODO');
    expect(written.tools.mcp_servers).toEqual([]);
  });

  it('round-trips a built-in with --from, renamed to the new name', async () => {
    expect(await roleCommand(parsed(['create', 'mybackend'], { from: 'backend' }))).toBe(0);
    const written = JSON.parse(readFileSync(join(userRolesDir(cwd), 'mybackend.json'), 'utf8'));
    expect(written.role).toBe('mybackend'); // renamed
    expect(written.tools.mcp_servers[0].name).toBe('supabase'); // copied from backend
  });

  it('refuses to overwrite without --force, then allows it with --force', async () => {
    await roleCommand(parsed(['create', 'qa']));
    await expect(roleCommand(parsed(['create', 'qa']))).rejects.toMatchObject({ exitCode: 1 });
    expect(await roleCommand(parsed(['create', 'qa'], { force: true, from: 'docs' }))).toBe(0);
    const written = JSON.parse(readFileSync(join(userRolesDir(cwd), 'qa.json'), 'utf8'));
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

describe('role dispatch', () => {
  it('rejects an unknown subcommand', async () => {
    await expect(roleCommand(parsed(['bogus']))).rejects.toBeInstanceOf(CliError);
  });
});
