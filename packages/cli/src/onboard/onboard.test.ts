import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from './harnesses/claudeCode.js';
import { cursor } from './harnesses/cursor.js';
import { HARNESSES } from './harnesses/index.js';
import { buildEntry, buildMcpEnv } from './mcpEntry.js';
import { renderPrimer, upsertPrimer } from './primer.js';

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

describe('agent primer', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-primer-'));
  });

  it('renders identity + the working-loop, with the role clause only when present', () => {
    const withRole = renderPrimer({ member: 'Ada', team: 'dawn', role: 'backend' });
    expect(withRole).toContain('**Ada**, the backend, on the **dawn** team');
    expect(withRole).toContain('team_join');
    expect(withRole).toContain('team_inbox_check');
    // status reporting is emphasized (flips the roster to `working`)
    expect(withRole).toContain('status_update');
    expect(withRole).toContain('working');
    expect(withRole).toContain('<!-- musterd:start');
    expect(withRole).toContain('<!-- musterd:end -->');

    const noRole = renderPrimer({ member: 'Lin', team: 'dawn', role: '   ' });
    expect(noRole).toContain('**Lin** on the **dawn** team');
    expect(noRole).not.toContain(', the ');
  });

  it('creates AGENTS.md when absent', () => {
    const block = renderPrimer({ member: 'Ada', team: 'dawn' });
    const { path, action } = upsertPrimer(cwd, block);
    expect(action).toBe('created');
    expect(path).toBe(join(cwd, 'AGENTS.md'));
    expect(readFileSync(path, 'utf8')).toContain('## Your musterd team');
  });

  it('appends below existing prose without clobbering it', () => {
    const agents = join(cwd, 'AGENTS.md');
    writeFileSync(agents, '# My project\n\nBuild with care.\n');
    const { action } = upsertPrimer(cwd, renderPrimer({ member: 'Ada', team: 'dawn' }));
    expect(action).toBe('appended');
    const out = readFileSync(agents, 'utf8');
    expect(out).toContain('# My project');
    expect(out).toContain('Build with care.');
    expect(out).toContain('## Your musterd team');
  });

  it('updates the managed block in place and is idempotent', () => {
    upsertPrimer(cwd, renderPrimer({ member: 'Ada', team: 'dawn', role: 'backend' }));
    const once = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    // Re-run with a changed role: only the managed block changes; exactly one block remains.
    const { action } = upsertPrimer(
      cwd,
      renderPrimer({ member: 'Ada', team: 'dawn', role: 'platform' }),
    );
    expect(action).toBe('updated');
    const twice = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    expect(twice.match(/musterd:start/g)).toHaveLength(1);
    expect(twice.match(/musterd:end/g)).toHaveLength(1);
    expect(twice).toContain('the platform,');
    expect(twice).not.toContain('the backend,');
    expect(twice.length).not.toBe(once.length);
  });

  it('does not touch text outside the markers on update', () => {
    const agents = join(cwd, 'AGENTS.md');
    upsertPrimer(cwd, renderPrimer({ member: 'Ada', team: 'dawn' }));
    // User adds their own prose after the block.
    const withUser = readFileSync(agents, 'utf8') + '\n## My own notes\nkeep me\n';
    writeFileSync(agents, withUser);
    upsertPrimer(cwd, renderPrimer({ member: 'Ada', team: 'dawn' }));
    expect(readFileSync(agents, 'utf8')).toContain('## My own notes\nkeep me');
  });
});

describe('harness registry', () => {
  it('exposes claude-code and cursor with distinct surfaces', () => {
    expect(HARNESSES.map((h) => h.id).sort()).toEqual(['claude-code', 'cursor']);
    expect(claudeCode.surface).toBe('claude-code');
    expect(cursor.surface).toBe('cursor');
  });

  // Non-hermetic: shells out to the real `claude` CLI (can take ~4–8s), so give it a generous
  // timeout — it trips vitest's 5s default under parallel load (flaky, but exercises the real probe).
  it('claude detect returns a shape even when probing the real CLI', async () => {
    const d = await claudeCode.detect();
    expect(typeof d.installed).toBe('boolean');
    expect(typeof d.configured).toBe('boolean');
  }, 15_000);
});
