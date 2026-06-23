import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  GENERALIST,
  isBuiltin,
  listRoleNames,
  loadRole,
  parseRole,
  resolveRoleLabel,
  userRolesDir,
} from './role.js';

describe('parseRole', () => {
  it('parses a minimal template and applies tool defaults', () => {
    const role = parseRole({ role: 'x', charter: 'do x' });
    expect(role.role).toBe('x');
    expect(role.tools.mcp_servers).toEqual([]);
    expect(role.tools.resource_scopes).toEqual([]);
    expect(role.tools.permissions).toEqual({ allow: [], ask: [], deny: [] });
  });

  it('joins an array charter into a single string (multi-line friendliness)', () => {
    const role = parseRole({ role: 'x', charter: ['line one', 'line two'] });
    expect(role.charter).toBe('line one\nline two');
  });

  it('defaults mcp_server args/env', () => {
    const role = parseRole({
      role: 'x',
      charter: 'c',
      tools: { mcp_servers: [{ name: 's', command: 'npx' }] },
    });
    expect(role.tools.mcp_servers[0]).toEqual({ name: 's', command: 'npx', args: [], env: {} });
  });

  it('rejects an empty charter', () => {
    expect(() => parseRole({ role: 'x', charter: '   ' })).toThrow();
  });

  it('rejects a missing role name', () => {
    expect(() => parseRole({ charter: 'c' })).toThrow();
  });

  it('rejects a non-positive capacity', () => {
    expect(() => parseRole({ role: 'x', charter: 'c', capacity: 0 })).toThrow();
  });
});

describe('built-in library', () => {
  it('ships the five seed archetypes, all valid', () => {
    expect(Object.keys(BUILTIN_ROLES).sort()).toEqual([
      'backend',
      'docs',
      'frontend',
      'generalist',
      'reviewer',
    ]);
  });

  it('generalist gets nothing extra — only a bare charter', () => {
    expect(BUILTIN_ROLES[GENERALIST]!.tools.mcp_servers).toEqual([]);
    expect(BUILTIN_ROLES[GENERALIST]!.charter.length).toBeGreaterThan(0);
  });

  it('backend references the supabase server with an ${ENV} secret, never inline', () => {
    const s = BUILTIN_ROLES['backend']!.tools.mcp_servers[0]!;
    expect(s.name).toBe('supabase');
    expect(Object.values(s.env)[0]).toMatch(/^\$\{[A-Z_]+\}$/);
  });
});

describe('loadRole / listRoleNames', () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'musterd-role-'));
  }

  it('loads a built-in by name', () => {
    expect(loadRole(tmp(), 'reviewer').role).toBe('reviewer');
  });

  it('throws a friendly error for an unknown role', () => {
    expect(() => loadRole(tmp(), 'nope')).toThrow(/unknown role/);
  });

  it('loads a user file from .musterd/roles/<name>.json', () => {
    const dir = tmp();
    mkdirSync(userRolesDir(dir), { recursive: true });
    writeFileSync(
      join(userRolesDir(dir), 'data.json'),
      JSON.stringify({ role: 'data', charter: 'own the warehouse' }),
    );
    expect(loadRole(dir, 'data').charter).toBe('own the warehouse');
    expect(isBuiltin('data')).toBe(false);
  });

  it('a user file overrides a built-in of the same name', () => {
    const dir = tmp();
    mkdirSync(userRolesDir(dir), { recursive: true });
    writeFileSync(
      join(userRolesDir(dir), 'backend.json'),
      JSON.stringify({ role: 'backend', charter: 'custom backend' }),
    );
    expect(loadRole(dir, 'backend').charter).toBe('custom backend');
  });

  it('throws a friendly error for an invalid user file', () => {
    const dir = tmp();
    mkdirSync(userRolesDir(dir), { recursive: true });
    writeFileSync(join(userRolesDir(dir), 'bad.json'), '{ not json');
    expect(() => loadRole(dir, 'bad')).toThrow(/could not read role/);
    writeFileSync(join(userRolesDir(dir), 'bad2.json'), JSON.stringify({ role: 'bad2' }));
    expect(() => loadRole(dir, 'bad2')).toThrow(/is invalid/);
  });

  it('lists built-ins ∪ user roles with generalist first', () => {
    const dir = tmp();
    mkdirSync(userRolesDir(dir), { recursive: true });
    writeFileSync(
      join(userRolesDir(dir), 'data.json'),
      JSON.stringify({ role: 'data', charter: 'c' }),
    );
    const names = listRoleNames(dir);
    expect(names[0]).toBe(GENERALIST);
    expect(names).toContain('data');
    expect(names).toContain('backend');
    // de-duplicated
    expect(names.filter((n) => n === 'backend')).toHaveLength(1);
  });

  it('lists only built-ins when there is no .musterd/roles/', () => {
    const names = listRoleNames(tmp());
    expect(names).toContain(GENERALIST);
    expect(names).not.toContain('data');
  });
});

describe('resolveRoleLabel', () => {
  const backend = parseRole({ role: 'backend', charter: 'own the server' });

  it('derives the label from the template when no free text is given', () => {
    expect(resolveRoleLabel({ template: backend })).toBe('backend');
    expect(resolveRoleLabel({ template: backend, freeText: '' })).toBe('backend');
    expect(resolveRoleLabel({ template: backend, freeText: '   ' })).toBe('backend');
  });

  it('lets an explicit free-text override win over the template', () => {
    expect(resolveRoleLabel({ template: backend, freeText: 'platform' })).toBe('platform');
    expect(resolveRoleLabel({ template: backend, freeText: '  platform  ' })).toBe('platform');
  });

  it('falls back to empty for generalist / no template with no free text', () => {
    expect(resolveRoleLabel({})).toBe('');
    expect(resolveRoleLabel({ template: undefined, freeText: '' })).toBe('');
  });

  it('uses free text alone when there is no template', () => {
    expect(resolveRoleLabel({ freeText: 'docs' })).toBe('docs');
  });
});
