import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProvisionManifest, writeProvisionManifest } from './manifest.js';
import { installSeatPermissions } from './permissions.js';
import {
  BUILTIN_TOOLKITS,
  GENERALIST,
  isBuiltin,
  listToolkitNames,
  loadToolkit,
  parseToolkit,
  userToolkitsDir,
} from './toolkit.js';

describe('parseToolkit', () => {
  it('parses a minimal toolkit and applies tool defaults', () => {
    const toolkit = parseToolkit({ toolkit: 'x', charter: 'do x' });
    expect(toolkit.toolkit).toBe('x');
    expect(toolkit.tools.mcp_servers).toEqual([]);
    expect(toolkit.tools.resource_scopes).toEqual([]);
    expect(toolkit.tools.permissions).toEqual({ allow: [], ask: [], deny: [] });
  });

  it('rejects the legacy `role` and `profile` name keys (dropped, ADR 324)', () => {
    expect(() => parseToolkit({ role: 'x', charter: 'do x' })).toThrow();
    expect(() => parseToolkit({ profile: 'x', charter: 'do x' })).toThrow();
  });

  it('joins an array charter into a single string (multi-line friendliness)', () => {
    const toolkit = parseToolkit({ toolkit: 'x', charter: ['line one', 'line two'] });
    expect(toolkit.charter).toBe('line one\nline two');
  });

  it('defaults mcp_server args/env', () => {
    const toolkit = parseToolkit({
      toolkit: 'x',
      charter: 'c',
      tools: { mcp_servers: [{ name: 's', command: 'npx' }] },
    });
    expect(toolkit.tools.mcp_servers[0]).toEqual({ name: 's', command: 'npx', args: [], env: {} });
  });

  it('defaults tools.codex_plugins to []', () => {
    expect(parseToolkit({ toolkit: 'x', charter: 'c' }).tools.codex_plugins).toEqual([]);
  });

  it('parses tools.codex_plugins as PLUGIN@MARKETPLACE ids', () => {
    const toolkit = parseToolkit({
      toolkit: 'security',
      charter: 'own appsec evidence',
      tools: { codex_plugins: ['codex-security@openai-curated'] },
    });
    expect(toolkit.tools.codex_plugins).toEqual(['codex-security@openai-curated']);
  });

  it('rejects a Codex plugin id that is not PLUGIN@MARKETPLACE', () => {
    expect(() =>
      parseToolkit({
        toolkit: 'x',
        charter: 'c',
        tools: { codex_plugins: ['codex-security'] },
      }),
    ).toThrow();
  });

  it('rejects an empty charter', () => {
    expect(() => parseToolkit({ toolkit: 'x', charter: '   ' })).toThrow();
  });

  it('rejects a missing toolkit name', () => {
    expect(() => parseToolkit({ charter: 'c' })).toThrow();
  });

  it('rejects a non-positive capacity', () => {
    expect(() => parseToolkit({ toolkit: 'x', charter: 'c', capacity: 0 })).toThrow();
  });
});

describe('built-in library', () => {
  it('ships the six seed archetypes, all valid', () => {
    expect(Object.keys(BUILTIN_TOOLKITS).sort()).toEqual([
      'backend',
      'docs',
      'frontend',
      'generalist',
      'read-only', // ADR 261: the ceiling archetype — deny-made-real
      'reviewer',
    ]);
  });

  it('generalist gets nothing extra — only a bare charter', () => {
    expect(BUILTIN_TOOLKITS[GENERALIST]!.tools.mcp_servers).toEqual([]);
    expect(BUILTIN_TOOLKITS[GENERALIST]!.charter.length).toBeGreaterThan(0);
  });

  it('backend references the supabase server with an ${ENV} secret, never inline', () => {
    const s = BUILTIN_TOOLKITS['backend']!.tools.mcp_servers[0]!;
    expect(s.name).toBe('supabase');
    expect(Object.values(s.env)[0]).toMatch(/^\$\{[A-Z_]+\}$/);
  });
});

describe('loadToolkit / listToolkitNames', () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'musterd-profile-'));
  }

  it('loads a built-in by name', () => {
    expect(loadToolkit(tmp(), 'reviewer').toolkit).toBe('reviewer');
  });

  it('throws a friendly error for an unknown toolkit', () => {
    expect(() => loadToolkit(tmp(), 'nope')).toThrow(/unknown toolkit/);
  });

  it('loads a user file from .musterd/toolkits/<name>.json', () => {
    const dir = tmp();
    mkdirSync(userToolkitsDir(dir), { recursive: true });
    writeFileSync(
      join(userToolkitsDir(dir), 'data.json'),
      JSON.stringify({ toolkit: 'data', charter: 'own the warehouse' }),
    );
    expect(loadToolkit(dir, 'data').charter).toBe('own the warehouse');
    expect(isBuiltin('data')).toBe(false);
  });

  it('no longer reads the legacy homes: a .musterd/roles/ or /profiles/ file is invisible (ADR 324)', () => {
    const dir = tmp();
    for (const legacyHome of [join(dir, '.musterd', 'roles'), join(dir, '.musterd', 'profiles')]) {
      mkdirSync(legacyHome, { recursive: true });
      writeFileSync(
        join(legacyHome, 'data.json'),
        JSON.stringify({ toolkit: 'data', charter: 'stale home' }),
      );
    }
    expect(() => loadToolkit(dir, 'data')).toThrow(/unknown toolkit/);
    expect(listToolkitNames(dir)).not.toContain('data');
  });

  it('a user file overrides a built-in of the same name', () => {
    const dir = tmp();
    mkdirSync(userToolkitsDir(dir), { recursive: true });
    writeFileSync(
      join(userToolkitsDir(dir), 'backend.json'),
      JSON.stringify({ toolkit: 'backend', charter: 'custom backend' }),
    );
    expect(loadToolkit(dir, 'backend').charter).toBe('custom backend');
  });

  it('a legacy-home file no longer shadows a built-in — the built-in wins (ADR 324)', () => {
    const dir = tmp();
    const legacyHome = join(dir, '.musterd', 'roles');
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(
      join(legacyHome, 'backend.json'),
      JSON.stringify({ toolkit: 'backend', charter: 'custom backend' }),
    );
    expect(loadToolkit(dir, 'backend').charter).not.toBe('custom backend');
  });

  it('throws a friendly error for an invalid user file', () => {
    const dir = tmp();
    mkdirSync(userToolkitsDir(dir), { recursive: true });
    writeFileSync(join(userToolkitsDir(dir), 'bad.json'), '{ not json');
    expect(() => loadToolkit(dir, 'bad')).toThrow(/could not read toolkit/);
    writeFileSync(join(userToolkitsDir(dir), 'bad2.json'), JSON.stringify({ toolkit: 'bad2' }));
    expect(() => loadToolkit(dir, 'bad2')).toThrow(/is invalid/);
  });

  it('lists built-ins ∪ user toolkit files with generalist first', () => {
    const dir = tmp();
    mkdirSync(userToolkitsDir(dir), { recursive: true });
    writeFileSync(
      join(userToolkitsDir(dir), 'data.json'),
      JSON.stringify({ toolkit: 'data', charter: 'c' }),
    );
    const names = listToolkitNames(dir);
    expect(names[0]).toBe(GENERALIST);
    expect(names).toContain('data');
    expect(names).toContain('backend');
    // de-duplicated
    expect(names.filter((n) => n === 'backend')).toHaveLength(1);
  });

  it('lists only built-ins when there is no user dir at all', () => {
    const names = listToolkitNames(tmp());
    expect(names).toContain(GENERALIST);
    expect(names).not.toContain('data');
  });
});

/**
 * The rename's proof (lane 01M017AXXC9 increment 1): every built-in renders the IDENTICAL
 * workspace it rendered before the rename. The fixture was generated on pre-rename main
 * (1d3468fe) by rendering each built-in role template: installSeatPermissions into a fresh
 * dir, then writeProvisionManifest — capturing settings.local.json, the manifest (timestamp
 * normalized), the added-permission lists, and the charter.
 */
describe('round-trip: built-ins render the identical workspace', () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, '__fixtures__', 'builtin-workspaces.json'), 'utf8'),
  ) as Record<
    string,
    {
      charter: string;
      capacity: number | null;
      mcpServers: unknown[];
      resourceScopes: string[];
      addedPermissions: { allow: string[]; ask: string[]; deny: string[] };
      settings: unknown;
      manifest: Record<string, unknown>;
    }
  >;

  it('covers exactly the shipped built-ins', () => {
    expect(Object.keys(fixture).sort()).toEqual(Object.keys(BUILTIN_TOOLKITS).sort());
  });

  for (const name of [
    'generalist',
    'reviewer',
    'backend',
    'frontend',
    'read-only',
    'docs',
  ] as const) {
    it(`${name}: identical settings, manifest, charter, and tool set`, () => {
      const expected = fixture[name]!;
      const toolkit = BUILTIN_TOOLKITS[name]!;
      expect(toolkit.charter).toBe(expected.charter);
      expect(toolkit.capacity ?? null).toBe(expected.capacity);
      expect(toolkit.tools.mcp_servers).toEqual(expected.mcpServers);
      expect(toolkit.tools.resource_scopes).toEqual(expected.resourceScopes);

      const dir = mkdtempSync(join(tmpdir(), `musterd-roundtrip-${name}-`));
      const added = installSeatPermissions(dir, toolkit);
      expect(added).toEqual(expected.addedPermissions);
      const settings = JSON.parse(
        readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'),
      );
      expect(settings).toEqual(expected.settings);

      writeProvisionManifest(dir, {
        profile: toolkit.toolkit,
        harness: 'claude-code',
        mcpServers: toolkit.tools.mcp_servers.map((s) => s.name),
        permissions: added,
      });
      const rawManifest = JSON.parse(
        readFileSync(join(dir, '.musterd', 'provisioned.json'), 'utf8'),
      ) as Record<string, unknown>;
      rawManifest['provisionedAt'] = '<normalized>';
      // Transition dual-write: the new manifest carries `profile` AND the legacy `role` key
      // (same value) so an older musterd elsewhere on this machine still parses its removal
      // set. Minus that added key, the manifest is byte-identical to the pre-rename one.
      expect(rawManifest['profile']).toBe(rawManifest['role']);
      const { profile: _added, ...compat } = rawManifest;
      expect(compat).toEqual(expected.manifest);

      // And the typed reader surfaces the new field.
      expect(readProvisionManifest(dir)?.profile).toBe(toolkit.toolkit);
    });
  }

});

/** Legacy manifest read: a pre-rename provisioned.json (role-keyed) still parses. */
describe('manifest back-compat', () => {
  it('reads a pre-rename role-keyed manifest, surfacing the name as `profile`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-manifest-legacy-'));
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'provisioned.json'),
      JSON.stringify({
        version: 1,
        role: 'backend',
        harness: 'claude-code',
        mcpServers: ['supabase'],
        permissions: { allow: ['Read'], ask: [], deny: [] },
        provisionedAt: '2026-08-01T00:00:00.000Z',
      }),
    );
    expect(readProvisionManifest(dir)?.profile).toBe('backend');
  });
});
