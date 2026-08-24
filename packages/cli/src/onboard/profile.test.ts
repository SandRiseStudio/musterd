import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProvisionManifest, writeProvisionManifest } from './manifest.js';
import { installSeatPermissions } from './permissions.js';
import {
  BUILTIN_PROFILES,
  GENERALIST,
  isBuiltin,
  legacyUserRolesDir,
  listProfileNames,
  loadProfile,
  parseProfile,
  userToolkitsDir,
  legacyUserProfilesDir,
} from './profile.js';

describe('parseProfile', () => {
  it('parses a minimal profile and applies tool defaults', () => {
    const profile = parseProfile({ toolkit: 'x', charter: 'do x' });
    expect(profile.toolkit).toBe('x');
    expect(profile.tools.mcp_servers).toEqual([]);
    expect(profile.tools.resource_scopes).toEqual([]);
    expect(profile.tools.permissions).toEqual({ allow: [], ask: [], deny: [] });
  });

  it('accepts the legacy `role` key as the profile name (pre-rename files)', () => {
    const profile = parseProfile({ role: 'x', charter: 'do x' });
    expect(profile.toolkit).toBe('x');
  });

  it('accepts the ADR 272 `profile` key as the toolkit name (pre-296 files)', () => {
    expect(parseProfile({ profile: 'x', charter: 'do x' }).toolkit).toBe('x');
  });

  it('prefers the newest key a hand-merged file carries (toolkit > profile > role)', () => {
    expect(
      parseProfile({ toolkit: 'new', profile: 'mid', role: 'old', charter: 'c' }).toolkit,
    ).toBe('new');
    expect(parseProfile({ profile: 'mid', role: 'old', charter: 'c' }).toolkit).toBe('mid');
  });

  it('a legacy role-keyed value parses identically to its profile-keyed form', () => {
    const legacy = parseProfile({
      role: 'x',
      charter: ['a', 'b'],
      tools: { mcp_servers: [{ name: 's', command: 'npx' }] },
    });
    const renamed = parseProfile({
      toolkit: 'x',
      charter: ['a', 'b'],
      tools: { mcp_servers: [{ name: 's', command: 'npx' }] },
    });
    expect(legacy).toEqual(renamed);
  });

  it('joins an array charter into a single string (multi-line friendliness)', () => {
    const profile = parseProfile({ toolkit: 'x', charter: ['line one', 'line two'] });
    expect(profile.charter).toBe('line one\nline two');
  });

  it('defaults mcp_server args/env', () => {
    const profile = parseProfile({
      toolkit: 'x',
      charter: 'c',
      tools: { mcp_servers: [{ name: 's', command: 'npx' }] },
    });
    expect(profile.tools.mcp_servers[0]).toEqual({ name: 's', command: 'npx', args: [], env: {} });
  });

  it('rejects an empty charter', () => {
    expect(() => parseProfile({ toolkit: 'x', charter: '   ' })).toThrow();
  });

  it('rejects a missing profile name', () => {
    expect(() => parseProfile({ charter: 'c' })).toThrow();
  });

  it('rejects a non-positive capacity', () => {
    expect(() => parseProfile({ toolkit: 'x', charter: 'c', capacity: 0 })).toThrow();
  });
});

describe('built-in library', () => {
  it('ships the six seed archetypes, all valid', () => {
    expect(Object.keys(BUILTIN_PROFILES).sort()).toEqual([
      'backend',
      'docs',
      'frontend',
      'generalist',
      'read-only', // ADR 261: the ceiling archetype — deny-made-real
      'reviewer',
    ]);
  });

  it('generalist gets nothing extra — only a bare charter', () => {
    expect(BUILTIN_PROFILES[GENERALIST]!.tools.mcp_servers).toEqual([]);
    expect(BUILTIN_PROFILES[GENERALIST]!.charter.length).toBeGreaterThan(0);
  });

  it('backend references the supabase server with an ${ENV} secret, never inline', () => {
    const s = BUILTIN_PROFILES['backend']!.tools.mcp_servers[0]!;
    expect(s.name).toBe('supabase');
    expect(Object.values(s.env)[0]).toMatch(/^\$\{[A-Z_]+\}$/);
  });
});

describe('loadProfile / listProfileNames', () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'musterd-profile-'));
  }

  it('loads a built-in by name', () => {
    expect(loadProfile(tmp(), 'reviewer').toolkit).toBe('reviewer');
  });

  it('throws a friendly error for an unknown toolkit', () => {
    expect(() => loadProfile(tmp(), 'nope')).toThrow(/unknown toolkit/);
  });

  it('loads a user file from .musterd/profiles/<name>.json', () => {
    const dir = tmp();
    mkdirSync(userToolkitsDir(dir), { recursive: true });
    writeFileSync(
      join(userToolkitsDir(dir), 'data.json'),
      JSON.stringify({ toolkit: 'data', charter: 'own the warehouse' }),
    );
    expect(loadProfile(dir, 'data').charter).toBe('own the warehouse');
    expect(isBuiltin('data')).toBe(false);
  });

  it('still loads a pre-rename user file from .musterd/roles/<name>.json (role-keyed)', () => {
    const dir = tmp();
    mkdirSync(legacyUserRolesDir(dir), { recursive: true });
    writeFileSync(
      join(legacyUserRolesDir(dir), 'data.json'),
      JSON.stringify({ role: 'data', charter: 'own the warehouse' }),
    );
    expect(loadProfile(dir, 'data').toolkit).toBe('data');
    expect(loadProfile(dir, 'data').charter).toBe('own the warehouse');
  });

  it('.musterd/profiles/ wins over the legacy .musterd/roles/ for the same name', () => {
    const dir = tmp();
    mkdirSync(userToolkitsDir(dir), { recursive: true });
    mkdirSync(legacyUserRolesDir(dir), { recursive: true });
    writeFileSync(
      join(userToolkitsDir(dir), 'data.json'),
      JSON.stringify({ toolkit: 'data', charter: 'new home' }),
    );
    writeFileSync(
      join(legacyUserRolesDir(dir), 'data.json'),
      JSON.stringify({ role: 'data', charter: 'old home' }),
    );
    expect(loadProfile(dir, 'data').charter).toBe('new home');
  });

  it('a user file overrides a built-in of the same name', () => {
    const dir = tmp();
    mkdirSync(userToolkitsDir(dir), { recursive: true });
    writeFileSync(
      join(userToolkitsDir(dir), 'backend.json'),
      JSON.stringify({ toolkit: 'backend', charter: 'custom backend' }),
    );
    expect(loadProfile(dir, 'backend').charter).toBe('custom backend');
  });

  it('a legacy user file also overrides a built-in of the same name (unchanged behavior)', () => {
    const dir = tmp();
    mkdirSync(legacyUserRolesDir(dir), { recursive: true });
    writeFileSync(
      join(legacyUserRolesDir(dir), 'backend.json'),
      JSON.stringify({ role: 'backend', charter: 'custom backend' }),
    );
    expect(loadProfile(dir, 'backend').charter).toBe('custom backend');
  });

  it('throws a friendly error for an invalid user file', () => {
    const dir = tmp();
    mkdirSync(userToolkitsDir(dir), { recursive: true });
    writeFileSync(join(userToolkitsDir(dir), 'bad.json'), '{ not json');
    expect(() => loadProfile(dir, 'bad')).toThrow(/could not read toolkit/);
    writeFileSync(join(userToolkitsDir(dir), 'bad2.json'), JSON.stringify({ toolkit: 'bad2' }));
    expect(() => loadProfile(dir, 'bad2')).toThrow(/is invalid/);
  });

  it('lists built-ins ∪ user profiles (both dirs) with generalist first', () => {
    const dir = tmp();
    mkdirSync(userToolkitsDir(dir), { recursive: true });
    mkdirSync(legacyUserRolesDir(dir), { recursive: true });
    writeFileSync(
      join(userToolkitsDir(dir), 'data.json'),
      JSON.stringify({ toolkit: 'data', charter: 'c' }),
    );
    writeFileSync(
      join(legacyUserRolesDir(dir), 'olddata.json'),
      JSON.stringify({ role: 'olddata', charter: 'c' }),
    );
    const names = listProfileNames(dir);
    expect(names[0]).toBe(GENERALIST);
    expect(names).toContain('data');
    expect(names).toContain('olddata');
    expect(names).toContain('backend');
    // de-duplicated
    expect(names.filter((n) => n === 'backend')).toHaveLength(1);
  });

  it('does not list the roster-role TOML files that share .musterd/roles/', () => {
    const dir = tmp();
    mkdirSync(legacyUserRolesDir(dir), { recursive: true });
    writeFileSync(join(legacyUserRolesDir(dir), 'platform.toml'), 'summary = "a roster role"\n');
    expect(listProfileNames(dir)).not.toContain('platform');
  });

  it('still loads an ADR 272 user file from .musterd/profiles/<name>.json (profile-keyed)', () => {
    const dir = tmp();
    mkdirSync(legacyUserProfilesDir(dir), { recursive: true });
    writeFileSync(
      join(legacyUserProfilesDir(dir), 'data.json'),
      JSON.stringify({ profile: 'data', charter: 'own the warehouse' }),
    );
    expect(loadProfile(dir, 'data').toolkit).toBe('data');
    expect(loadProfile(dir, 'data').charter).toBe('own the warehouse');
  });

  it('walks the homes newest-first: toolkits/ beats profiles/ beats roles/', () => {
    const dir = tmp();
    for (const [home, key, charter] of [
      [userToolkitsDir(dir), 'toolkit', 'newest home'],
      [legacyUserProfilesDir(dir), 'profile', 'middle home'],
      [legacyUserRolesDir(dir), 'role', 'oldest home'],
    ] as const) {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'data.json'), JSON.stringify({ [key]: 'data', charter }));
    }
    expect(loadProfile(dir, 'data').charter).toBe('newest home');
  });

  it('lists user files from all three homes', () => {
    const dir = tmp();
    for (const [home, key, name] of [
      [userToolkitsDir(dir), 'toolkit', 'newdata'],
      [legacyUserProfilesDir(dir), 'profile', 'middata'],
      [legacyUserRolesDir(dir), 'role', 'olddata'],
    ] as const) {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, `${name}.json`), JSON.stringify({ [key]: name, charter: 'c' }));
    }
    const names = listProfileNames(dir);
    expect(names).toContain('newdata');
    expect(names).toContain('middata');
    expect(names).toContain('olddata');
  });

  it('lists only built-ins when there is no user dir at all', () => {
    const names = listProfileNames(tmp());
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
    expect(Object.keys(fixture).sort()).toEqual(Object.keys(BUILTIN_PROFILES).sort());
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
      const profile = BUILTIN_PROFILES[name]!;
      expect(profile.charter).toBe(expected.charter);
      expect(profile.capacity ?? null).toBe(expected.capacity);
      expect(profile.tools.mcp_servers).toEqual(expected.mcpServers);
      expect(profile.tools.resource_scopes).toEqual(expected.resourceScopes);

      const dir = mkdtempSync(join(tmpdir(), `musterd-roundtrip-${name}-`));
      const added = installSeatPermissions(dir, profile);
      expect(added).toEqual(expected.addedPermissions);
      const settings = JSON.parse(
        readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'),
      );
      expect(settings).toEqual(expected.settings);

      writeProvisionManifest(dir, {
        profile: profile.toolkit,
        harness: 'claude-code',
        mcpServers: profile.tools.mcp_servers.map((s) => s.name),
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
      expect(readProvisionManifest(dir)?.profile).toBe(profile.toolkit);
    });
  }

  it('a legacy role-keyed user file renders the same workspace as its profile-keyed twin', () => {
    const raw = {
      charter: ['own the data layer'],
      capacity: 2,
      tools: {
        resource_scopes: ['packages/db/**'],
        mcp_servers: [{ name: 's', command: 'npx', args: ['-y', 'x'], env: { K: '${K}' } }],
        permissions: { allow: ['Read'], ask: ['Bash'], deny: ['Write'] },
      },
    };
    const dirLegacy = mkdtempSync(join(tmpdir(), 'musterd-legacy-'));
    const dirNew = mkdtempSync(join(tmpdir(), 'musterd-new-'));
    mkdirSync(legacyUserRolesDir(dirLegacy), { recursive: true });
    mkdirSync(userToolkitsDir(dirNew), { recursive: true });
    writeFileSync(
      join(legacyUserRolesDir(dirLegacy), 'data.json'),
      JSON.stringify({ role: 'data', ...raw }),
    );
    writeFileSync(
      join(userToolkitsDir(dirNew), 'data.json'),
      JSON.stringify({ toolkit: 'data', ...raw }),
    );
    const fromLegacy = loadProfile(dirLegacy, 'data');
    const fromNew = loadProfile(dirNew, 'data');
    expect(fromLegacy).toEqual(fromNew);

    const addedLegacy = installSeatPermissions(dirLegacy, fromLegacy);
    const addedNew = installSeatPermissions(dirNew, fromNew);
    expect(addedLegacy).toEqual(addedNew);
    expect(
      JSON.parse(readFileSync(join(dirLegacy, '.claude', 'settings.local.json'), 'utf8')),
    ).toEqual(JSON.parse(readFileSync(join(dirNew, '.claude', 'settings.local.json'), 'utf8')));
  });
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
