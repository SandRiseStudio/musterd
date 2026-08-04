import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetMemberIdentity,
  loadMemberIdentity,
  resolveIdentity,
  saveMemberIdentity,
} from './memberIdentity';

const LEGACY = (team: string) => `musterd.board.member.v1.${team}`;
const CURRENT = (team: string) => `musterd.member.v1.${team}`;

/** The repo's web-test pattern: a stubbed `window`, not a DOM env (vitest runs `environment: node`). */
function stubStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    },
  });
  return map;
}

describe('memberIdentity', () => {
  beforeEach(() => stubStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips an identity under the shared per-team key', () => {
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_abc' });
    expect(window.localStorage.getItem(CURRENT('revive'))).toBeTruthy();
    expect(loadMemberIdentity('revive')).toEqual({ as: 'nick', token: 'mscr_abc' });
  });

  it('keeps teams apart so two projects on one machine never cross', () => {
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_a' });
    saveMemberIdentity('other', { as: 'nsanders', token: 'mscr_b' });
    expect(loadMemberIdentity('revive')?.as).toBe('nick');
    expect(loadMemberIdentity('other')?.as).toBe('nsanders');
  });

  it("migrates /board's legacy key on read, then writes it forward", () => {
    window.localStorage.setItem(
      LEGACY('revive'),
      JSON.stringify({ as: 'nick', token: 'mscr_legacy' }),
    );
    expect(loadMemberIdentity('revive')).toEqual({ as: 'nick', token: 'mscr_legacy' });
    expect(window.localStorage.getItem(CURRENT('revive'))).toBeTruthy();
  });

  it('prefers the current key when both exist', () => {
    window.localStorage.setItem(LEGACY('revive'), JSON.stringify({ as: 'old', token: 'mscr_old' }));
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_new' });
    expect(loadMemberIdentity('revive')?.as).toBe('nick');
  });

  it('returns null for absent, malformed, and half-shaped records', () => {
    expect(loadMemberIdentity('revive')).toBeNull();
    window.localStorage.setItem(CURRENT('revive'), 'not json');
    expect(loadMemberIdentity('revive')).toBeNull();
    window.localStorage.setItem(CURRENT('revive'), JSON.stringify({ as: 'nick' }));
    expect(loadMemberIdentity('revive')).toBeNull();
  });

  it('forget clears both the current and the legacy key', () => {
    window.localStorage.setItem(LEGACY('revive'), JSON.stringify({ as: 'x', token: 'mscr_x' }));
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_a' });
    forgetMemberIdentity('revive');
    expect(loadMemberIdentity('revive')).toBeNull();
    expect(window.localStorage.getItem(LEGACY('revive'))).toBeNull();
  });
});

describe('resolveIdentity — the precedence chain', () => {
  beforeEach(() => stubStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('an explicit watch link beats a stored member — it is how the team hands the office over', () => {
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_member' });
    expect(resolveIdentity('revive', { as: 'watcher', token: 'mscr_watch' })).toEqual({
      kind: 'watch',
      as: 'watcher',
      token: 'mscr_watch',
    });
  });

  it('a stored member beats an auto observer', () => {
    saveMemberIdentity('revive', { as: 'nick', token: 'mscr_member' });
    expect(resolveIdentity('revive', null)).toEqual({
      kind: 'member',
      as: 'nick',
      token: 'mscr_member',
    });
  });

  it('falls through to the observer when nothing is stored', () => {
    expect(resolveIdentity('revive', null)).toBeNull();
  });

  it('resolves the migrated /board identity, so signing in there reaches /live', () => {
    window.localStorage.setItem(
      LEGACY('revive'),
      JSON.stringify({ as: 'nick', token: 'mscr_legacy' }),
    );
    expect(resolveIdentity('revive', null)).toEqual({
      kind: 'member',
      as: 'nick',
      token: 'mscr_legacy',
    });
  });
});
