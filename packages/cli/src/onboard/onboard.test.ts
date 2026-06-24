import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectInitTarget, nameBoundElsewhere } from './guard.js';
import { claudeCode } from './harnesses/claudeCode.js';
import { cursor } from './harnesses/cursor.js';
import { HARNESSES } from './harnesses/index.js';
import { buildEntry, buildMcpEnv } from './mcpEntry.js';
import { classifyPrimerTarget, removePrimer, renderPrimer, upsertPrimer } from './primer.js';

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

  it('provisions role MCP servers additively and reports no permissions (Cursor has no allowlist)', async () => {
    await cursor.configure(buildEntry(binding), binding); // seed musterd
    const result = await cursor.provision!({
      servers: [
        {
          name: 'figma',
          command: 'npx',
          args: ['-y', 'figma-mcp'],
          env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' },
        },
      ],
      permissions: { allow: ['edit'], ask: [], deny: [] },
    });
    expect(result.servers).toEqual(['figma']);
    expect(result.permissions).toEqual({ allow: [], ask: [], deny: [] });
    const written = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(written.mcpServers.musterd).toBeTruthy(); // untouched
    expect(written.mcpServers.figma.env.FIGMA_API_KEY).toBe('${FIGMA_API_KEY}'); // reference kept
  });

  it('unprovisions exactly the named servers, leaving the rest', async () => {
    await cursor.configure(buildEntry(binding), binding);
    await cursor.provision!({
      servers: [{ name: 'figma', command: 'npx', args: [], env: {} }],
      permissions: { allow: [], ask: [], deny: [] },
    });
    await cursor.unprovision!({
      servers: ['figma'],
      permissions: { allow: [], ask: [], deny: [] },
    });
    const written = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
    expect(written.mcpServers.figma).toBeUndefined();
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
    // channel-aware: the CLI form is documented alongside the team_* tools (ADR 012 follow-up)
    expect(withRole).toContain('musterd inbox');
    expect(withRole).toContain('musterd help');
    // status reporting is emphasized (flips the roster to `working`)
    expect(withRole).toContain('status_update');
    expect(withRole).toContain('working');
    expect(withRole).toContain('<!-- musterd:start');
    expect(withRole).toContain('<!-- musterd:end -->');

    const noRole = renderPrimer({ member: 'Lin', team: 'dawn', role: '   ' });
    expect(noRole).toContain('**Lin** on the **dawn** team');
    expect(noRole).not.toContain(', the ');
  });

  it('renders a self-claim primer when no seat is assigned (the fresh, unprovisioned agent)', () => {
    const unprovisioned = renderPrimer({ team: 'alpha' });
    expect(unprovisioned).toContain('claim your seat first');
    expect(unprovisioned).toContain('musterd claim');
    // still the full working-loop, both channels
    expect(unprovisioned).toContain('team_inbox_check');
    expect(unprovisioned).toContain('musterd inbox');
    // no fixed-seat identity line when there's no member
    expect(unprovisioned).not.toContain('You are **');
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

  // classifyPrimerTarget drives the honest init confirm; each value maps to upsertPrimer's action.
  it('classifies an absent AGENTS.md as `none` (the prompt offers to write a fresh file)', () => {
    expect(classifyPrimerTarget(cwd)).toBe('none');
    expect(upsertPrimer(cwd, renderPrimer({ member: 'Ada', team: 'dawn' })).action).toBe('created');
  });

  it('classifies an existing unmarked AGENTS.md as `unmarked` (the prompt says append)', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# My project\n\nBuild with care.\n');
    expect(classifyPrimerTarget(cwd)).toBe('unmarked');
    expect(upsertPrimer(cwd, renderPrimer({ member: 'Ada', team: 'dawn' })).action).toBe(
      'appended',
    );
  });

  it('classifies an already-managed AGENTS.md as `managed` (the prompt says update)', () => {
    upsertPrimer(cwd, renderPrimer({ member: 'Ada', team: 'dawn' }));
    expect(classifyPrimerTarget(cwd)).toBe('managed');
    expect(upsertPrimer(cwd, renderPrimer({ member: 'Ada', team: 'dawn' })).action).toBe('updated');
  });

  it('injects a role charter inside the managed block when provided', () => {
    const block = renderPrimer({
      member: 'Ada',
      team: 'dawn',
      role: 'backend',
      charter: 'own the data layer',
    });
    expect(block).toContain('## Your charter (backend)');
    expect(block).toContain('own the data layer');
  });

  it('removePrimer strips the managed block, keeping the user’s prose', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# My project\n\nBuild with care.\n');
    upsertPrimer(cwd, renderPrimer({ member: 'Ada', team: 'dawn' }));
    expect(removePrimer(cwd).action).toBe('removed');
    const out = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    expect(out).toContain('# My project');
    expect(out).not.toContain('musterd:start');
  });

  it('removePrimer reports `absent`/`missing` when there is no managed block', () => {
    expect(removePrimer(cwd).action).toBe('missing');
    writeFileSync(join(cwd, 'AGENTS.md'), '# Just mine\n');
    expect(removePrimer(cwd).action).toBe('absent');
  });
});

describe('init target guard', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-guard-'));
  });

  it('trips nothing in a clean folder', () => {
    expect(inspectInitTarget(cwd).warnings).toEqual([]);
  });

  it('trips on the musterd source tree (by package name)', () => {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'musterd-monorepo' }));
    const { warnings } = inspectInitTarget(cwd);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('source tree');
  });

  it('trips on the musterd source tree (by packages/{cli,server} layout)', () => {
    mkdirSync(join(cwd, 'packages', 'cli'), { recursive: true });
    mkdirSync(join(cwd, 'packages', 'server'), { recursive: true });
    writeFileSync(join(cwd, 'packages', 'cli', 'package.json'), '{}');
    writeFileSync(join(cwd, 'packages', 'server', 'package.json'), '{}');
    expect(inspectInitTarget(cwd).warnings[0]).toContain('source tree');
  });

  it('trips on a folder already bound to a member, naming who', () => {
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(join(cwd, '.musterd', 'binding.json'), JSON.stringify(binding));
    const { warnings } = inspectInitTarget(cwd);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ada');
    expect(warnings[0]).toContain('dawn');
  });

  it('does NOT trip on an unrelated AGENTS.md — the primer step asks in context (§5b)', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# Contributor guide\n\nBuild with care.\n');
    expect(inspectInitTarget(cwd).warnings).toEqual([]);
  });

  it('does NOT trip on an AGENTS.md that already has the musterd primer', () => {
    upsertPrimer(cwd, renderPrimer({ member: 'Ada', team: 'dawn' }));
    expect(inspectInitTarget(cwd).warnings).toEqual([]);
  });

  it('accumulates multiple warnings', () => {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'musterd-monorepo' }));
    mkdirSync(join(cwd, '.musterd'), { recursive: true });
    writeFileSync(join(cwd, '.musterd', 'binding.json'), JSON.stringify(binding));
    expect(inspectInitTarget(cwd).warnings.length).toBe(2);
  });
});

describe('cross-folder name-reuse (nameBoundElsewhere)', () => {
  const reg = (folder: string, member: string, team = 'dawn') => ({
    [folder]: { team, member, surface: 'claude-code' },
  });

  it('flags a name bound in a different folder, returning that folder + team', () => {
    const hit = nameBoundElsewhere('Ada', '/work/api', reg('/work/web', 'Ada', 'dawn'));
    expect(hit).toEqual({ folder: '/work/web', team: 'dawn' });
  });

  it('ignores the same folder (a re-run here is heuristic 2, not name reuse)', () => {
    expect(nameBoundElsewhere('Ada', '/work/web', reg('/work/web', 'Ada'))).toBeNull();
  });

  it('normalizes paths before comparing (trailing slash / relative segments)', () => {
    expect(nameBoundElsewhere('Ada', '/work/web/', reg('/work/web/sub/..', 'Ada'))).toBeNull();
  });

  it('returns null when the name is bound nowhere', () => {
    expect(nameBoundElsewhere('Lin', '/work/api', reg('/work/web', 'Ada'))).toBeNull();
  });

  it('returns null on an empty registry', () => {
    expect(nameBoundElsewhere('Ada', '/work/api', {})).toBeNull();
  });
});

describe('harness registry', () => {
  it('exposes claude-code and cursor with distinct surfaces', () => {
    expect(HARNESSES.map((h) => h.id).sort()).toEqual(['claude-code', 'codex', 'cursor']);
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
