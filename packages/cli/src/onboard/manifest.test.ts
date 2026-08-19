import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadProvisioning,
  PROVISION_MANIFEST_FILE,
  readProvisionManifest,
  saveProvisioning,
  writeProvisionManifest,
} from './manifest.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'musterd-manifest-'));
}

describe('provision manifest', () => {
  it('writes a versioned manifest and reads it back', () => {
    const dir = tmp();
    const path = writeProvisionManifest(dir, {
      profile: 'backend',
      harness: 'claude-code',
      mcpServers: ['supabase'],
    });
    expect(path).toBe(join(dir, BINDING_DIR, PROVISION_MANIFEST_FILE));
    const m = readProvisionManifest(dir)!;
    expect(m.version).toBe(1);
    expect(m.profile).toBe('backend');
    expect(m.harness).toBe('claude-code');
    expect(m.mcpServers).toEqual(['supabase']);
    expect(typeof m.provisionedAt).toBe('string');
  });

  it('records and unions provisioned permissions across re-provisions', () => {
    const dir = tmp();
    writeProvisionManifest(dir, {
      profile: 'reviewer',
      harness: 'claude-code',
      mcpServers: [],
      permissions: { allow: ['read'], ask: ['bash'], deny: [] },
    });
    writeProvisionManifest(dir, {
      profile: 'backend',
      harness: 'claude-code',
      mcpServers: [],
      permissions: { allow: ['edit', 'read'], ask: [], deny: [] },
    });
    const m = readProvisionManifest(dir)!;
    expect(m.permissions.allow).toEqual(['edit', 'read']); // sorted union
    expect(m.permissions.ask).toEqual(['bash']);
  });

  it('defaults permissions to empty when omitted (back-compatible manifest)', () => {
    const dir = tmp();
    writeProvisionManifest(dir, { profile: 'x', harness: 'h', mcpServers: ['s'] });
    expect(readProvisionManifest(dir)!.permissions).toEqual({ allow: [], ask: [], deny: [] });
  });

  it('unions server names across re-provisions (stays a complete removal set)', () => {
    const dir = tmp();
    writeProvisionManifest(dir, {
      profile: 'backend',
      harness: 'claude-code',
      mcpServers: ['supabase'],
    });
    writeProvisionManifest(dir, {
      profile: 'frontend',
      harness: 'claude-code',
      mcpServers: ['figma'],
    });
    const m = readProvisionManifest(dir)!;
    expect(m.mcpServers).toEqual(['figma', 'supabase']); // sorted union
    expect(m.profile).toBe('frontend'); // latest provision
  });

  it('records the guidance surface and preserves it across a profile-only re-provision (ADR 085)', () => {
    const dir = tmp();
    writeProvisionManifest(dir, {
      profile: 'backend',
      harness: 'claude-code',
      mcpServers: [],
      guidance: { files: ['.musterd/skill/SKILL.md'], contentVersion: 1 },
    });
    expect(readProvisionManifest(dir)!.guidance).toEqual({
      files: ['.musterd/skill/SKILL.md'],
      contentVersion: 1,
    });
    // A later provision that doesn't touch guidance must not drop it.
    writeProvisionManifest(dir, {
      profile: 'frontend',
      harness: 'claude-code',
      mcpServers: ['figma'],
    });
    expect(readProvisionManifest(dir)!.guidance?.files).toEqual(['.musterd/skill/SKILL.md']);
  });

  it('returns null when there is no manifest', () => {
    expect(readProvisionManifest(tmp())).toBeNull();
  });

  it('returns null for a corrupt or invalid manifest', () => {
    const dir = tmp();
    writeProvisionManifest(dir, { profile: 'x', harness: 'h', mcpServers: [] });
    const path = join(dir, BINDING_DIR, PROVISION_MANIFEST_FILE);
    writeFileSync(path, '{ not json');
    expect(readProvisionManifest(dir)).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(readProvisionManifest(dir)).toBeNull();
  });
});

describe('loadProvisioning — classified v2 loads (ADR 281/282)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-prov-'));
  });

  const v2 = {
    version: 2,
    role: 'backend',
    desired: ['claude-code', 'musterd'],
    contributions: { 'claude-code': ['folder:/w#hooks'] },
    provisionedAt: '2026-08-19T12:00:00.000Z',
  };
  const v1 = {
    version: 1,
    role: 'backend',
    harness: 'claude-code',
    mcpServers: ['musterd'],
    permissions: { allow: [], ask: [], deny: [] },
    provisionedAt: '2026-08-01T00:00:00.000Z',
  };
  const writeRaw = (value: unknown) => {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'provisioned.json'),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };

  it('absent → missing', () => {
    expect(loadProvisioning(dir).kind).toBe('missing');
  });

  it('strict v2 → valid; saveProvisioning round-trips it', () => {
    saveProvisioning(dir, v2 as Parameters<typeof saveProvisioning>[1]);
    const got = loadProvisioning(dir);
    expect(got.kind).toBe('valid');
    if (got.kind === 'valid') expect(got.value.desired).toEqual(['claude-code', 'musterd']);
  });

  it('a well-formed version-1 manifest → legacy (recognized, never consumed)', () => {
    writeRaw(v1);
    expect(loadProvisioning(dir).kind).toBe('legacy');
  });

  it('unknown versions, invalid JSON, and unknown keys → invalid, never legacy', () => {
    writeRaw({ ...v2, version: 3 });
    expect(loadProvisioning(dir).kind).toBe('invalid');
    writeRaw('{ nope');
    expect(loadProvisioning(dir).kind).toBe('invalid');
    writeRaw({ ...v2, extra: 1 });
    expect(loadProvisioning(dir).kind).toBe('invalid');
    // Duplicate desired ids violate the uniqueness refinement.
    writeRaw({ ...v2, desired: ['codex', 'codex'] });
    expect(loadProvisioning(dir).kind).toBe('invalid');
  });

  it('saveProvisioning refuses an invalid object before any byte moves', () => {
    saveProvisioning(dir, v2 as Parameters<typeof saveProvisioning>[1]);
    const before = readFileSync(join(dir, '.musterd', 'provisioned.json'), 'utf8');
    expect(() =>
      saveProvisioning(dir, { ...v2, desired: ['Not An Id'] } as Parameters<
        typeof saveProvisioning
      >[1]),
    ).toThrow(/worktree-provisioning/);
    expect(readFileSync(join(dir, '.musterd', 'provisioned.json'), 'utf8')).toBe(before);
  });
});
