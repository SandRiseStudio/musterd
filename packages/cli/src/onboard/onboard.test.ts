import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectInitTarget, nameBoundElsewhere } from './guard.js';
import { claudeCode } from './harnesses/claudeCode.js';
import { cursor } from './harnesses/cursor.js';
import { HARNESSES } from './harnesses/index.js';
import { opencode } from './harnesses/opencode.js';
import { buildEntry, buildMcpEnv } from './mcpEntry.js';
import {
  classifyPrimerTarget,
  removePrimer,
  renderRepositoryPrimer,
  upsertPrimer,
} from './primer.js';

const binding = {
  version: 2 as const,
  server: 'http://localhost:4849',
  team: 'dawn',
  agent_key: 'mskey_secret',
  claim: { mode: 'seat' as const, name: 'Ada' },
};

describe('mcpEntry', () => {
  it('emits NO per-seat state — the entry is shared by every worktree of the repo (ADR 165)', () => {
    // Claude Code keys local-scope MCP config by REPO ROOT, so all `agents-*` seat worktrees share
    // ONE entry. Anything per-seat in it is a single global slot the next provisioning run overwrites
    // — and `MUSTERD_GRANT`/`MUSTERD_AGENT_KEY` are *credentials*, which the adapter ranks ABOVE
    // binding.json, so the loser presents a sibling's secret at claim time. The adapter resolves all
    // of these from `.musterd/binding.json` (found by walking up from cwd) or the committed
    // `workspace.json`, both of which are genuinely per-worktree.
    expect(buildMcpEnv(binding)).toEqual({});
  });

  it('keeps the env names working as manual overrides — it just stops materializing them', () => {
    // Regression guard on intent: this task removed the *writer*, not the reader. If someone later
    // "restores" any of these to the entry, the shared-slot defect returns.
    for (const k of [
      'MUSTERD_SERVER',
      'MUSTERD_TEAM',
      'MUSTERD_AGENT_KEY',
      'MUSTERD_GRANT',
      'MUSTERD_SURFACE',
      'MUSTERD_CLAIM',
      'MUSTERD_MODEL',
    ]) {
      expect(buildMcpEnv(binding)[k]).toBeUndefined();
    }
  });

  it('NEVER emits MUSTERD_MODEL, declared or not (a snapshot must not outrank an observation)', () => {
    // This assertion is the REVERSE of what it was. Baking a declared model looked like "attest by
    // default instead of rotting to unknown", but the baked env is the top rung of the adapter's
    // ladder: the copy outranked every later observation and could never be corrected, so one seat
    // attested `grok-4.5` for weeks while running `claude-opus-4-8`. A model is a harness fact, so
    // it now comes from an observation (the SessionStart probe) or `binding.model` — never frozen
    // into harness config at wire time.
    expect(buildMcpEnv(binding)['MUSTERD_MODEL']).toBeUndefined();
    expect(
      buildMcpEnv({ ...binding, model: 'grok-4.5' } as typeof binding & { model: string })[
        'MUSTERD_MODEL'
      ],
    ).toBeUndefined();
  });

  it('resolves a runnable launch command for the adapter', () => {
    const entry = buildEntry(binding);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args[0]).toMatch(/index\.(js|ts)$/);
    expect(entry.env).toEqual({});
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
    // ADR 165: the written entry carries no per-seat state — team comes from binding/workspace.
    expect(written.mcpServers.musterd.env).toEqual({});

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

  it('renders repository-stable Team context plus the working loop', () => {
    const primer = renderRepositoryPrimer({ team: 'dawn' });
    expect(primer).toContain('**dawn** Team');
    expect(primer).toContain('musterd whoami');
    expect(primer).toContain('team_join');
    expect(primer).toContain('team_inbox_check');
    // channel-aware: the CLI form is documented alongside the team_* tools (ADR 012 follow-up)
    expect(primer).toContain('musterd inbox');
    expect(primer).toContain('musterd help');
    // status reporting is emphasized (flips the roster to `working`)
    expect(primer).toContain('status_update');
    expect(primer).toContain('working');
    expect(primer).toContain('<!-- musterd:start');
    expect(primer).toContain('<!-- musterd:end -->');
    for (const localFact of ['Ada', 'backend', 'own the data layer', 'supabase']) {
      expect(primer).not.toContain(localFact);
    }
  });

  it('creates AGENTS.md when absent', () => {
    const block = renderRepositoryPrimer({ team: 'dawn' });
    const { path, action } = upsertPrimer(cwd, block);
    expect(action).toBe('created');
    expect(path).toBe(join(cwd, 'AGENTS.md'));
    expect(readFileSync(path, 'utf8')).toContain('## Your musterd team');
  });

  it('appends below existing prose without clobbering it', () => {
    const agents = join(cwd, 'AGENTS.md');
    writeFileSync(agents, '# My project\n\nBuild with care.\n');
    const { action } = upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' }));
    expect(action).toBe('appended');
    const out = readFileSync(agents, 'utf8');
    expect(out).toContain('# My project');
    expect(out).toContain('Build with care.');
    expect(out).toContain('## Your musterd team');
  });

  it('updates the managed block in place and is idempotent', () => {
    upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' }));
    const once = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    // Re-run with the same repository intent: exactly one block remains and its bytes are stable.
    const { action } = upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' }));
    expect(action).toBe('updated');
    const twice = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    expect(twice.match(/musterd:start/g)).toHaveLength(1);
    expect(twice.match(/musterd:end/g)).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it('does not touch text outside the markers on update', () => {
    const agents = join(cwd, 'AGENTS.md');
    upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' }));
    // User adds their own prose after the block.
    const withUser = readFileSync(agents, 'utf8') + '\n## My own notes\nkeep me\n';
    writeFileSync(agents, withUser);
    upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' }));
    expect(readFileSync(agents, 'utf8')).toContain('## My own notes\nkeep me');
  });

  // classifyPrimerTarget drives the honest init confirm; each value maps to upsertPrimer's action.
  it('classifies an absent AGENTS.md as `none` (the prompt offers to write a fresh file)', () => {
    expect(classifyPrimerTarget(cwd)).toBe('none');
    expect(upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' })).action).toBe('created');
  });

  it('classifies an existing unmarked AGENTS.md as `unmarked` (the prompt says append)', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# My project\n\nBuild with care.\n');
    expect(classifyPrimerTarget(cwd)).toBe('unmarked');
    expect(upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' })).action).toBe('appended');
  });

  it('classifies an already-managed AGENTS.md as `managed` (the prompt says update)', () => {
    upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' }));
    expect(classifyPrimerTarget(cwd)).toBe('managed');
    expect(upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' })).action).toBe('updated');
  });

  it('migrates a Member-specific managed block to repository-neutral bytes', () => {
    const agents = join(cwd, 'AGENTS.md');
    writeFileSync(
      agents,
      '# Project rules\n\n<!-- musterd:start -->\nYou are **Stanley** on the **dawn** Team.\n<!-- musterd:end -->\n\n## Keep me\n',
    );

    upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' }));

    const written = readFileSync(agents, 'utf8');
    expect(written).not.toContain('Stanley');
    expect(written).toContain('musterd whoami');
    expect(written).toContain('# Project rules');
    expect(written).toContain('## Keep me');
  });

  it('removePrimer strips the managed block, keeping the user’s prose', () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# My project\n\nBuild with care.\n');
    upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' }));
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
    upsertPrimer(cwd, renderRepositoryPrimer({ team: 'dawn' }));
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
  const reg = (folder: string, seat: string, team = 'dawn') => ({
    [folder]: { team, seat, surface: 'claude-code' },
  });

  it('flags a name bound in a different folder, returning that folder + team', () => {
    // The folder must actually EXIST: a registry entry outlives the folder it names, and ADR 162
    // makes a vanished folder a non-collision (warning about a deleted path is unactionable).
    const other = mkdtempSync(join(tmpdir(), 'musterd-reuse-'));
    try {
      const hit = nameBoundElsewhere('Ada', '/work/api', reg(other, 'Ada', 'dawn'));
      expect(hit).toEqual({ folder: other, team: 'dawn' });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('ignores an entry whose folder is gone (ADR 162)', () => {
    const gone = join(tmpdir(), 'musterd-reuse-never-existed');
    expect(nameBoundElsewhere('Ada', '/work/api', reg(gone, 'Ada', 'dawn'))).toBeNull();
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
    expect(HARNESSES.map((h) => h.id).sort()).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'opencode',
    ]);
    expect(claudeCode.surface).toBe('claude-code');
    expect(cursor.surface).toBe('cursor');
    expect(opencode.surface).toBe('opencode');
  });

  // Non-hermetic: shells out to the real `claude` CLI (can take ~4–8s), so give it a generous
  // timeout — it trips vitest's 5s default under parallel load (flaky, but exercises the real probe).
  // MUST run from a temp cwd: `claude mcp get musterd` reads local-scope config from the cwd, and in
  // a bound workspace (this repo!) it health-checks the REAL adapter — which used to fire a real
  // claim against the production daemon and displace the live seat (the supersession ping-pong; the
  // adapter is probe-safe now, but a test suite must never touch a production daemon regardless).
  it('claude detect returns a shape even when probing the real CLI', async () => {
    const probeCwd = mkdtempSync(join(tmpdir(), 'musterd-detect-'));
    const origCwd = process.cwd();
    process.chdir(probeCwd);
    try {
      const d = await claudeCode.detect();
      expect(typeof d.installed).toBe('boolean');
      expect(typeof d.configured).toBe('boolean');
    } finally {
      process.chdir(origCwd);
      rmSync(probeCwd, { recursive: true, force: true });
    }
    // Higher than the 30s global: this is the only test that spawns an EXTERNAL binary, and process
    // start-up is the first thing to stall on a swap-bound machine. Measured 2.2s idle, but it blew
    // an explicit 15s ceiling under whole-suite load — the starvation factor here is worse than the
    // in-process tests, not better, because it is waiting on the OS rather than on the event loop.
  }, 60_000);
});
