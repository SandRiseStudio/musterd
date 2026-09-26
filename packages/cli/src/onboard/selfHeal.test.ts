import { describe, expect, it, vi } from 'vitest';
import { selfHealWorkspace, type SelfHealDeps } from './selfHeal.js';

/**
 * `selfHealWorkspace` (spec 2026-09-16, ADR 408) — pure over injected deps, so nothing here touches
 * a real folder's hooks. The policy line is asserted by absence: there is no permissions dep to
 * call, and the tests check it was never repaired.
 */
const drifted = {
  guidance: ['a.md', 'b.md'],
  hooks: ['.claude/settings.local.json'],
  permissions: ['mcp__musterd'],
};
const clean = { guidance: [], hooks: [], permissions: [] };

function deps(over: Partial<SelfHealDeps> = {}): SelfHealDeps {
  return {
    // First inspect sees drift; the re-inspect after repair sees only the permissions gap.
    inspect: vi
      .fn()
      .mockReturnValueOnce(drifted)
      .mockReturnValueOnce({ ...clean, permissions: drifted.permissions }),
    refreshGuidance: vi.fn(() => 0),
    refreshHooks: vi.fn(() => ({
      code: 0,
      files: ['.claude/settings.local.json'],
      skipped: [],
      refused: 0,
    })),
    declined: () => false,
    checkoutBehind: () => false,
    build: 'abc1234',
    ...over,
  };
}

describe('selfHealWorkspace', () => {
  it('repairs guidance and hooks, never permissions, and reports what remains', () => {
    const d = deps();
    const out = selfHealWorkspace('/w', d);
    expect(d.refreshGuidance).toHaveBeenCalledWith('/w', { quiet: true });
    expect(d.refreshHooks).toHaveBeenCalledWith('/w', { withinWorktreeOnly: true, quiet: true });
    expect(out.ran).toBe(true);
    expect(out.report).toEqual({
      build: 'abc1234',
      repaired: { guidance: 2, hooks: 1 },
      skipped: [{ class: 'permissions', reason: 'policy' }],
      remaining: { guidance: 0, hooks: 0, permissions: 1 },
    });
    expect(out.line).toBe(
      'musterd: repaired 2 guidance files and 1 hook; the harness permission layer is still behind — run `musterd init --refresh-permissions`.',
    );
  });

  it('is silent and does nothing when clean', () => {
    const d = deps({ inspect: vi.fn(() => clean) });
    const out = selfHealWorkspace('/w', d);
    expect(out).toEqual({ ran: false, report: null, line: '' });
    expect(d.refreshGuidance).not.toHaveBeenCalled();
    expect(d.refreshHooks).not.toHaveBeenCalled();
  });

  it('declined: repairs nothing, falls back to the prescription, says why', () => {
    const d = deps({ declined: () => true, inspect: vi.fn(() => drifted) });
    const out = selfHealWorkspace('/w', d);
    expect(d.refreshGuidance).not.toHaveBeenCalled();
    expect(d.refreshHooks).not.toHaveBeenCalled();
    expect(out.ran).toBe(false);
    expect(out.report?.skipped).toEqual([
      { class: 'guidance', reason: 'declined' },
      { class: 'hooks', reason: 'declined' },
      { class: 'permissions', reason: 'policy' },
    ]);
    expect(out.report?.remaining).toEqual({ guidance: 2, hooks: 1, permissions: 1 });
    expect(out.line).toContain('self-heal is declined in this folder');
    expect(out.line).toContain('`musterd init --refresh-guidance`');
    expect(out.line).toContain('`musterd init --refresh-hooks`');
    expect(out.line).toContain('`musterd init --refresh-permissions`');
  });

  it('checkout behind: repairs nothing and says the checkout, not the hook, is the problem', () => {
    const d = deps({ checkoutBehind: () => true, inspect: vi.fn(() => drifted) });
    const out = selfHealWorkspace('/w', d);
    expect(d.refreshGuidance).not.toHaveBeenCalled();
    expect(d.refreshHooks).not.toHaveBeenCalled();
    expect(out.report?.skipped.map((s) => s.reason)).toEqual([
      'checkout_behind',
      'checkout_behind',
      'policy',
    ]);
    expect(out.line).toContain('this checkout is behind');
    expect(out.line).not.toContain('--refresh-hooks');
  });

  it('a write outside the worktree is reported as skipped, and what it left is counted as remaining', () => {
    const d = deps({
      refreshHooks: vi.fn(() => ({
        code: 0,
        files: [],
        skipped: ['/shared/.codex/hooks.json'],
        refused: 0,
      })),
      inspect: vi
        .fn()
        .mockReturnValueOnce(drifted)
        .mockReturnValueOnce({ ...drifted, guidance: [] }),
    });
    const out = selfHealWorkspace('/w', d);
    expect(out.report?.skipped).toContainEqual({
      class: 'hooks',
      reason: 'outside_worktree',
      path: '/shared/.codex/hooks.json',
    });
    expect(out.report?.repaired).toEqual({ guidance: 2, hooks: 0 });
    expect(out.report?.remaining.hooks).toBe(1);
    expect(out.line).toContain('/shared/.codex/hooks.json');
    expect(out.line).toContain('needs a human');
  });

  it('a skipped shared file is not named when no hook drift remains — it was already current', () => {
    const d = deps({
      refreshHooks: vi.fn(() => ({
        code: 0,
        files: ['/w/.claude/settings.local.json'],
        skipped: ['/home/.claude/settings.json'],
        refused: 0,
      })),
      inspect: vi
        .fn()
        .mockReturnValueOnce(drifted)
        .mockReturnValueOnce({ guidance: [], hooks: [], permissions: [] }),
    });
    const out = selfHealWorkspace('/w', d);
    // The report still records the skip — it is true — but the line asks nothing of a human.
    expect(out.report?.skipped).toContainEqual({
      class: 'hooks',
      reason: 'outside_worktree',
      path: '/home/.claude/settings.json',
    });
    expect(out.line).not.toContain('/home/.claude/settings.json');
    expect(out.line).not.toContain('needs a human');
    expect(out.line).not.toMatch(/run\s*\./);
    expect(out.line).toMatch(/^musterd: repaired .*\.$/);
  });

  it('a throwing refresh never escapes — the line still reports and nothing is claimed repaired', () => {
    const d = deps({
      refreshGuidance: vi.fn(() => {
        throw new Error('boom');
      }),
      inspect: vi.fn(() => drifted),
    });
    const out = selfHealWorkspace('/w', d);
    expect(out.report?.repaired.guidance).toBe(0);
    expect(out.report?.remaining.guidance).toBe(2);
    expect(out.line.length).toBeGreaterThan(0);
    expect(out.line).toContain('`musterd init --refresh-guidance`');
  });

  it('a refused refresh (ADR 168 downgrade guard) counts nothing as repaired', () => {
    const d = deps({
      refreshHooks: vi.fn(() => ({ code: 1, files: [], skipped: [], refused: 1 })),
      inspect: vi.fn(() => drifted),
    });
    const out = selfHealWorkspace('/w', d);
    expect(out.report?.repaired.hooks).toBe(0);
    expect(out.report?.remaining.hooks).toBe(1);
  });
});
