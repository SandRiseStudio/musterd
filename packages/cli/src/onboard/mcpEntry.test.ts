import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpEnv, canonicalizeAdapterPath, type AgentBinding } from './mcpEntry.js';

/**
 * The regression guard for the attestation-truth incident: a seat attested `grok-4.5` for weeks
 * while running `claude-opus-4-8`, because provisioning baked `MUSTERD_MODEL` into the harness MCP
 * entry — the TOP rung of the adapter's ladder, where no later observation could correct it.
 */
describe('buildMcpEnv', () => {
  const base: AgentBinding = {
    server: 'http://127.0.0.1:4849',
    team: 'revive',
    surface: 'claude-code',
    claim: { mode: 'seat', name: 'ryder' },
  };

  it('NEVER bakes MUSTERD_MODEL — a wire-time snapshot must not outrank a live observation', () => {
    // Pass a model anyway (callers hand in a full Binding, which still carries the declared tier):
    // it must not reach the env no matter how it arrives.
    const env = buildMcpEnv({ ...base, model: 'grok-4.5' } as AgentBinding & { model: string });
    expect(env).not.toHaveProperty('MUSTERD_MODEL');
  });

  it('does not bake MUSTERD_CLAIM either — binding.json stays the single source of truth', () => {
    expect(buildMcpEnv(base)).not.toHaveProperty('MUSTERD_CLAIM');
  });

  it('bakes NOTHING — the slot is shared by the whole worktree family (ADR 165)', () => {
    // This test used to assert the OPPOSITE: that server/team/surface/key/grant "cannot drift out
    // from under us" and were safe to bake. That premise was wrong in exactly one way that matters:
    // the entry is keyed by repo root, so it is one slot shared by every seat worktree, and a per-seat
    // credential in a shared slot means the last writer's secret is presented by every sibling at
    // claim time. Zero-sum, not stale. Everything now resolves from binding.json / workspace.json.
    const env = buildMcpEnv({ ...base, agent_key: 'mskey_x', grant: 'msgr_y' });
    expect(env).toEqual({});
  });
});

/**
 * The 01KZ9JT1CG root-cause fix: the shared MCP slot (ADR 143) was destructive to rewrite because
 * the adapter path was anchored on whichever checkout ran the writer last. Canonicalizing the
 * COMPUTED value onto the primary checkout makes every writer write the same bytes.
 */
describe('canonicalizeAdapterPath', () => {
  let root: string;
  const adapterRel = join('packages', 'mcp', 'dist', 'index.js');

  /** A primary checkout (`.git` directory) with a built adapter. */
  function makePrimary(name: string): string {
    const dir = join(root, name);
    mkdirSync(join(dir, '.git'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'mcp', 'dist'), { recursive: true });
    writeFileSync(join(dir, adapterRel), '// adapter');
    return dir;
  }

  /** A linked worktree of `primary` (`.git` FILE with a gitdir pointer) with its own adapter build. */
  function makeWorktree(name: string, primary: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(primary, '.git', 'worktrees', name), { recursive: true });
    writeFileSync(join(dir, '.git'), `gitdir: ${join(primary, '.git', 'worktrees', name)}\n`);
    mkdirSync(join(dir, 'packages', 'mcp', 'dist'), { recursive: true });
    writeFileSync(join(dir, adapterRel), '// adapter');
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcpentry-canon-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('re-anchors a worktree adapter onto the primary checkout — the idempotence fix', () => {
    const primary = makePrimary('agents');
    const wt = makeWorktree('agents-izzo', primary);
    expect(canonicalizeAdapterPath(join(wt, adapterRel))).toBe(join(primary, adapterRel));
  });

  it('leaves the primary checkout adapter alone — it is already the canonical answer', () => {
    const primary = makePrimary('agents');
    const p = join(primary, adapterRel);
    expect(canonicalizeAdapterPath(p)).toBe(p);
  });

  it('leaves a non-checkout path alone — a global install has no worktree family', () => {
    const dir = join(root, 'global', 'node_modules', '@musterd', 'mcp', 'dist');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'index.js');
    writeFileSync(p, '// adapter');
    expect(canonicalizeAdapterPath(p)).toBe(p);
  });

  it('falls back to the worktree copy when the primary has no built adapter — a path that exists beats a canonical one that does not', () => {
    const primary = makePrimary('agents');
    rmSync(join(primary, 'packages'), { recursive: true, force: true });
    const wt = makeWorktree('agents-izzo', primary);
    const p = join(wt, adapterRel);
    expect(canonicalizeAdapterPath(p)).toBe(p);
  });
});
