import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntry, buildMcpEnv } from './mcpEntry.js';
import { cursor } from './harnesses/cursor.js';
import { claudeCode } from './harnesses/claudeCode.js';
import { HARNESSES } from './harnesses/index.js';

const binding = {
  server: 'http://localhost:4849',
  team: 'dawn',
  member: 'Ada',
  token: 'mskd_secret',
  surface: 'cursor' as const,
};

describe('mcpEntry', () => {
  it('builds the identity-binding env', () => {
    expect(buildMcpEnv(binding)).toEqual({
      MUSTERD_SERVER: 'http://localhost:4849',
      MUSTERD_TEAM: 'dawn',
      MUSTERD_MEMBER: 'Ada',
      MUSTERD_TOKEN: 'mskd_secret',
      MUSTERD_SURFACE: 'cursor',
    });
  });

  it('resolves a runnable launch command for the adapter', () => {
    const entry = buildEntry(binding);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args[0]).toMatch(/index\.(js|ts)$/);
    expect(entry.env['MUSTERD_MEMBER']).toBe('Ada');
  });
});

describe('cursor harness', () => {
  let cwd: string;
  let origCwd: string;
  beforeEach(() => {
    origCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'musterd-cursor-'));
    process.chdir(cwd);
  });
  afterEach(() => {
    process.chdir(origCwd);
  });

  it('configures .cursor/mcp.json and then detects itself as configured', async () => {
    const before = await cursor.detect();
    expect(before.configured).toBe(false);

    const entry = buildEntry(binding);
    const result = await cursor.configure(entry, binding);
    expect(result.target).toContain('.cursor/mcp.json');

    const written = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(written.mcpServers.musterd.command).toBe(process.execPath);
    expect(written.mcpServers.musterd.env.MUSTERD_TEAM).toBe('dawn');

    const after = await cursor.detect();
    expect(after.configured).toBe(true);
  });

  it('preserves existing servers when adding musterd', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(
      join(cwd, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }),
    );
    await cursor.configure(buildEntry(binding), binding);
    const written = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(written.mcpServers.other).toBeTruthy();
    expect(written.mcpServers.musterd).toBeTruthy();
  });
});

describe('harness registry', () => {
  it('exposes claude-code and cursor with distinct surfaces', () => {
    expect(HARNESSES.map((h) => h.id).sort()).toEqual(['claude-code', 'cursor']);
    expect(claudeCode.surface).toBe('claude-code');
    expect(cursor.surface).toBe('cursor');
  });

  it('claude detect returns a shape even when probing the real CLI', async () => {
    const d = await claudeCode.detect();
    expect(typeof d.installed).toBe('boolean');
    expect(typeof d.configured).toBe('boolean');
  });
});
