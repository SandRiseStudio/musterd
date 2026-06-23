import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  PROVISION_MANIFEST_FILE,
  readProvisionManifest,
  writeProvisionManifest,
} from './manifest.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'musterd-manifest-'));
}

describe('provision manifest', () => {
  it('writes a versioned manifest and reads it back', () => {
    const dir = tmp();
    const path = writeProvisionManifest(dir, {
      role: 'backend',
      harness: 'claude-code',
      mcpServers: ['supabase'],
    });
    expect(path).toBe(join(dir, BINDING_DIR, PROVISION_MANIFEST_FILE));
    const m = readProvisionManifest(dir)!;
    expect(m.version).toBe(1);
    expect(m.role).toBe('backend');
    expect(m.harness).toBe('claude-code');
    expect(m.mcpServers).toEqual(['supabase']);
    expect(typeof m.provisionedAt).toBe('string');
  });

  it('records and unions provisioned permissions across re-provisions', () => {
    const dir = tmp();
    writeProvisionManifest(dir, {
      role: 'reviewer',
      harness: 'claude-code',
      mcpServers: [],
      permissions: { allow: ['read'], ask: ['bash'], deny: [] },
    });
    writeProvisionManifest(dir, {
      role: 'backend',
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
    writeProvisionManifest(dir, { role: 'x', harness: 'h', mcpServers: ['s'] });
    expect(readProvisionManifest(dir)!.permissions).toEqual({ allow: [], ask: [], deny: [] });
  });

  it('unions server names across re-provisions (stays a complete removal set)', () => {
    const dir = tmp();
    writeProvisionManifest(dir, {
      role: 'backend',
      harness: 'claude-code',
      mcpServers: ['supabase'],
    });
    writeProvisionManifest(dir, {
      role: 'frontend',
      harness: 'claude-code',
      mcpServers: ['figma'],
    });
    const m = readProvisionManifest(dir)!;
    expect(m.mcpServers).toEqual(['figma', 'supabase']); // sorted union
    expect(m.role).toBe('frontend'); // latest provision
  });

  it('returns null when there is no manifest', () => {
    expect(readProvisionManifest(tmp())).toBeNull();
  });

  it('returns null for a corrupt or invalid manifest', () => {
    const dir = tmp();
    writeProvisionManifest(dir, { role: 'x', harness: 'h', mcpServers: [] });
    const path = join(dir, BINDING_DIR, PROVISION_MANIFEST_FILE);
    writeFileSync(path, '{ not json');
    expect(readProvisionManifest(dir)).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(readProvisionManifest(dir)).toBeNull();
  });
});
