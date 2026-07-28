import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOFF_TTL_MS, redeemHandoff, stageHandoff, __resetHandoffs } from './signinHandoff.js';

/**
 * The sign-in handoff relay (ADR 170). Everything here is about the nonce being *worthless after
 * use* — the property that lets the CLI put it in a URL at all. No DB: the relay is deliberately
 * memory-only (a handoff older than a minute is void, so nothing about it should survive a restart).
 */
describe('sign-in handoff relay (ADR 170)', () => {
  beforeEach(() => {
    __resetHandoffs();
    vi.useRealTimers();
  });

  it('redeems once and returns the staged identity', () => {
    const { nonce } = stageHandoff({ team: 'revive', member: 'nick', credential: 'mscr_x' });
    expect(redeemHandoff('revive', nonce)).toEqual({ as: 'nick', credential: 'mscr_x' });
  });

  it('is single-use — the second redemption finds nothing (the whole point of the nonce)', () => {
    const { nonce } = stageHandoff({ team: 'revive', member: 'nick', credential: 'mscr_x' });
    expect(redeemHandoff('revive', nonce)).not.toBeNull();
    expect(redeemHandoff('revive', nonce)).toBeNull();
  });

  it('expires — a link left in history overnight is inert', () => {
    vi.useFakeTimers();
    const { nonce } = stageHandoff({ team: 'revive', member: 'nick', credential: 'mscr_x' });
    vi.advanceTimersByTime(HANDOFF_TTL_MS + 1);
    expect(redeemHandoff('revive', nonce)).toBeNull();
  });

  it('is team-scoped — a nonce staged for one team never redeems on another', () => {
    const { nonce } = stageHandoff({ team: 'revive', member: 'nick', credential: 'mscr_x' });
    expect(redeemHandoff('other', nonce)).toBeNull();
    // …and the failed cross-team attempt did not burn it for its own team.
    expect(redeemHandoff('revive', nonce)).not.toBeNull();
  });

  it('an unknown nonce is simply nothing', () => {
    expect(redeemHandoff('revive', 'never-staged')).toBeNull();
  });

  it('mints unguessable, unique nonces (no counter, no derivation from the credential)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { nonce } = stageHandoff({ team: 'revive', member: 'nick', credential: 'mscr_x' });
      expect(nonce.length).toBeGreaterThanOrEqual(24);
      expect(nonce).not.toContain('mscr_');
      seen.add(nonce);
    }
    expect(seen.size).toBe(50);
  });

  it('reports the TTL it actually applied, so the CLI never invents its own number', () => {
    const staged = stageHandoff({ team: 'revive', member: 'nick', credential: 'mscr_x' });
    expect(staged.expires_in_ms).toBe(HANDOFF_TTL_MS);
  });

  it('sweeps expired entries on write — a stale relay never accumulates', () => {
    vi.useFakeTimers();
    const first = stageHandoff({ team: 'revive', member: 'nick', credential: 'mscr_x' });
    vi.advanceTimersByTime(HANDOFF_TTL_MS + 1);
    stageHandoff({ team: 'revive', member: 'nick', credential: 'mscr_x' });
    // The expired one is gone from the map, not merely unreadable.
    expect(redeemHandoff('revive', first.nonce)).toBeNull();
  });
});
