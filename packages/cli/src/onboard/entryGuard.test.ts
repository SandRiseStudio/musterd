import { describe, expect, it } from 'vitest';
import { assertEntryIdentity, EntryIdentityError, isInside } from './entryGuard.js';

const entry = (adapterPath: string, env: Record<string, string> = {}) => ({
  command: '/usr/bin/node',
  args: [adapterPath],
  env: { MUSTERD_SERVER: 'http://127.0.0.1:4849', MUSTERD_TEAM: 'revive', ...env },
});

describe('isInside', () => {
  it('is path-segment aware — a name prefix is not containment', () => {
    expect(isInside('/Users/x/agents-ryder/pkg/i.js', '/Users/x/agents-ryder')).toBe(true);
    expect(isInside('/Users/x/agents-ryder', '/Users/x/agents-ryder')).toBe(true);
    // `agents-ryder2` must NOT read as inside `agents-ryder`, or the guard both over- and
    // under-fires on the sibling worktrees this exists to tell apart.
    expect(isInside('/Users/x/agents-ryder2/pkg/i.js', '/Users/x/agents-ryder')).toBe(false);
    expect(isInside('/Users/x/agents-miley/pkg/i.js', '/Users/x/agents-ryder')).toBe(false);
  });
});

describe('assertEntryIdentity', () => {
  const ryder = '/Users/x/agents-ryder';
  const miley = '/Users/x/agents-miley';
  const adapterIn = (ws: string) => `${ws}/packages/mcp/dist/index.js`;

  it('accepts an adapter inside the target workspace', () => {
    expect(() =>
      assertEntryIdentity(entry(adapterIn(ryder)), { workspaceDir: ryder, siblingDirs: [miley] }),
    ).not.toThrow();
  });

  it('accepts a shared global install (the normal npm/brew case)', () => {
    expect(() =>
      assertEntryIdentity(entry('/opt/homebrew/lib/node_modules/@musterd/mcp/dist/index.js'), {
        workspaceDir: ryder,
        siblingDirs: [miley],
      }),
    ).not.toThrow();
  });

  it('REFUSES an adapter inside a sibling seat worktree (the incident)', () => {
    expect(() =>
      assertEntryIdentity(entry(adapterIn(miley)), { workspaceDir: ryder, siblingDirs: [miley] }),
    ).toThrow(EntryIdentityError);
  });

  it('names both workspaces in the refusal, so the fix needs no investigation', () => {
    try {
      assertEntryIdentity(entry(adapterIn(miley)), { workspaceDir: ryder, siblingDirs: [miley] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EntryIdentityError);
      expect((e as Error).message).toContain('agents-miley');
      expect((e as Error).message).toContain('agents-ryder');
    }
  });

  it('refuses a grant belonging to a different provisioning run', () => {
    expect(() =>
      assertEntryIdentity(entry(adapterIn(ryder), { MUSTERD_GRANT: 'msgr_other' }), {
        workspaceDir: ryder,
        binding: { grant: 'msgr_mine' },
      }),
    ).toThrow(/grant/);
  });

  it('refuses an agent key belonging to a different team or run', () => {
    expect(() =>
      assertEntryIdentity(entry(adapterIn(ryder), { MUSTERD_AGENT_KEY: 'mskey_other' }), {
        workspaceDir: ryder,
        binding: { agent_key: 'mskey_mine' },
      }),
    ).toThrow(/agent key/);
  });

  it('allows matching secrets', () => {
    expect(() =>
      assertEntryIdentity(
        entry(adapterIn(ryder), { MUSTERD_GRANT: 'msgr_mine', MUSTERD_AGENT_KEY: 'mskey_mine' }),
        { workspaceDir: ryder, binding: { grant: 'msgr_mine', agent_key: 'mskey_mine' } },
      ),
    ).not.toThrow();
  });

  it('allows a first-time wire, where the workspace has no binding to compare against', () => {
    expect(() =>
      assertEntryIdentity(entry(adapterIn(ryder), { MUSTERD_GRANT: 'msgr_fresh' }), {
        workspaceDir: ryder,
      }),
    ).not.toThrow();
  });

  it('does not invent siblings — with none declared, any outside adapter is allowed', () => {
    // Only a KNOWN sibling seat worktree is a refusal. Everything else (a global install, a monorepo
    // checkout elsewhere) stays legal: this guard blocks cross-seat leakage, not unusual layouts.
    expect(() =>
      assertEntryIdentity(entry(adapterIn(miley)), { workspaceDir: ryder }),
    ).not.toThrow();
  });
});
