import { describe, expect, it } from 'vitest';
import { composeSessionStatusline, type SessionStatuslineInput } from './sessionStatusline.js';

const base: SessionStatuslineInput = {
  seat: 'dolly',
  team: 'revive',
  waiting: 12,
  incidents: 0,
  carrying: 0,
};

describe('composeSessionStatusline', () => {
  it('renders the chip: seat, team, waiting count, idle lane', () => {
    expect(composeSessionStatusline(base)).toBe('🔶 dolly · revive · ⚑12 waiting · lane: none');
  });

  it('drops the waiting segment when the inbox is clear', () => {
    const out = composeSessionStatusline({ ...base, waiting: 0 });
    expect(out).toBe('🔶 dolly · revive · lane: none');
  });

  it('counts carried lanes instead of "none"', () => {
    expect(composeSessionStatusline({ ...base, waiting: 0, carrying: 2 })).toBe(
      '🔶 dolly · revive · lane: 2 in flight',
    );
  });

  it('surfaces incidents ahead of waiting — a shared red outranks a personal inbox', () => {
    const out = composeSessionStatusline({ ...base, incidents: 3 });
    expect(out).toBe('🔶 dolly · revive · 🔴3 incidents · ⚑12 waiting · lane: none');
  });

  it('is one line even when every segment is populated', () => {
    const out = composeSessionStatusline({
      seat: 'dolly',
      team: 'revive',
      waiting: 99,
      incidents: 40,
      carrying: 7,
    });
    expect(out).not.toBeNull();
    expect(out?.split('\n')).toHaveLength(1);
  });

  it('composes only counts and validated slugs — no free text can reach the statusline', () => {
    // The orientation block fences its one free-text field (the memory headline). The statusline
    // takes the stricter road and carries NONE: a persistent surface that redraws every turn is a
    // worse place to host attacker-controlled bytes than a one-shot block, and the chip has no
    // room for prose anyway. Slugs that fail their shape gate kill the chip rather than escape.
    expect(composeSessionStatusline({ ...base, seat: 'dolly\nrm -rf /' })).toBeNull();
    expect(composeSessionStatusline({ ...base, team: '../../etc' })).toBeNull();
    expect(composeSessionStatusline({ ...base, seat: '' })).toBeNull();
  });

  it('is bounded: absurd counts cannot stretch the line without limit', () => {
    const out = composeSessionStatusline({
      seat: 'dolly',
      team: 'revive',
      waiting: 10 ** 12,
      incidents: 10 ** 12,
      carrying: 10 ** 12,
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(80);
  });

  it('renders a quiet seat rather than nothing — unlike the orientation, presence IS the signal', () => {
    // composeSessionOrientation returns null when there is nothing to say, because an empty block
    // is pure token cost. The statusline inverts that: the chip answers "which seat am I?", which
    // is worth showing precisely when the inbox is empty.
    expect(
      composeSessionStatusline({
        seat: 'dolly',
        team: 'revive',
        waiting: 0,
        incidents: 0,
        carrying: 0,
      }),
    ).toBe('🔶 dolly · revive · lane: none');
  });
});
