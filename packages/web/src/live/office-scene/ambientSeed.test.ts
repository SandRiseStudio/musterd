import { describe, expect, it } from 'vitest';
import { AMBIENT_SLOT_MS, decideAmbient, roll, slotAt, slotRng } from './ambientSeed';

/**
 * The shared-seed contract (E1 spec §2): every ambient decision is a pure function of inputs every
 * viewer already holds — team slug, wall-clock slot, purpose tag. What's worth pinning is the
 * falsifier itself: same inputs → same value on any machine, different purpose/slot/team →
 * independent draws, and a distribution healthy enough to weight beats with.
 */

describe('slotAt — the 20 s lattice', () => {
  it('floors wall-clock time into fixed slots', () => {
    expect(slotAt(0)).toBe(0);
    expect(slotAt(AMBIENT_SLOT_MS - 1)).toBe(0);
    expect(slotAt(AMBIENT_SLOT_MS)).toBe(1);
    expect(slotAt(AMBIENT_SLOT_MS * 7 + 3)).toBe(7);
  });

  it('two viewers with skewed clocks inside one slot agree on the slot', () => {
    const t = 1_756_000_000_000; // an arbitrary real epoch ms
    const skewMs = 4_000; // ordinary NTP-grade skew, well under the 20 s slot
    expect(slotAt(t)).toBe(slotAt(t + skewMs - (t % AMBIENT_SLOT_MS > AMBIENT_SLOT_MS - skewMs ? skewMs : 0)));
  });
});

describe('roll — one shared draw per (team, slot, purpose)', () => {
  it('is deterministic: two viewers computing the same draw get the same value', () => {
    expect(roll('revive', 87_654_321, 'fire')).toBe(roll('revive', 87_654_321, 'fire'));
  });

  it('stays in [0, 1)', () => {
    for (let s = 0; s < 1000; s++) {
      const v = roll('revive', s, 'fire');
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('purposes are independent — one slot yields as many uncorrelated draws as a beat needs', () => {
    const s = 42;
    const values = ['fire', 'actor', 'beat', 'pet-follow', 'phone-stop-2'].map((p) => roll('revive', s, p));
    expect(new Set(values).size).toBe(values.length);
  });

  it('slots are independent — consecutive slots do not repeat or trend', () => {
    const values = Array.from({ length: 200 }, (_, s) => roll('revive', s, 'fire'));
    expect(new Set(values).size).toBe(values.length);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
  });

  it('teams are independent — two teams watching the same wall clock see different rooms', () => {
    const a = Array.from({ length: 50 }, (_, s) => roll('revive', s, 'fire'));
    const b = Array.from({ length: 50 }, (_, s) => roll('other-team', s, 'fire'));
    expect(a).not.toEqual(b);
  });

  it('fills its range — no bucket collapse (the appearance.ts FNV lesson)', () => {
    const buckets = new Array(10).fill(0);
    for (let s = 0; s < 2000; s++) buckets[Math.floor(roll('revive', s, 'beat') * 10)]!++;
    for (const count of buckets) expect(count).toBeGreaterThan(100);
  });
});

describe('slotRng — a slot-scoped sequence for beat interiors', () => {
  it('is deterministic: both viewers playing the same beat draw the same sequence', () => {
    const a = slotRng('revive', 7, 'walk');
    const b = slotRng('revive', 7, 'walk');
    expect([a(), a(), a(), a()]).toEqual([b(), b(), b(), b()]);
  });

  it('is slot-scoped: no state survives the slot, so a skipped slot cannot desync the next one', () => {
    const first = slotRng('revive', 7, 'walk');
    first(); first(); first(); // one viewer consumes; the other never ran this slot
    const fresh = slotRng('revive', 8, 'walk');
    const other = slotRng('revive', 8, 'walk');
    expect(fresh()).toBe(other());
  });

  it('draws within a sequence are independent and in [0, 1)', () => {
    const rng = slotRng('revive', 3, 'walk');
    const values = Array.from({ length: 100 }, () => rng());
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('decideAmbient — the per-slot decision, pure over the shared pool', () => {
  const pool = {
    members: ['ada', 'bo', 'cy', 'dev', 'eli', 'fen'],
    pairs: [['ada', 'bo'], ['cy', 'dev']] as Array<[string, string]>,
  };

  it('two viewers over the same slot range and pool produce identical decision logs', () => {
    const log = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => decideAmbient('revive', from + i, pool));
    expect(log(0, 500)).toEqual(log(0, 500));
    // A viewer that missed the first 300 slots reconverges immediately: per-slot purity means the
    // overlap is identical regardless of where either viewer started.
    expect(log(300, 500)).toEqual(log(0, 500).slice(300));
  });

  it('ignores pool array order — candidate ordering is canonical, array order never leaks in', () => {
    const shuffled = {
      members: ['fen', 'cy', 'ada', 'eli', 'bo', 'dev'],
      pairs: [['cy', 'dev'], ['ada', 'bo']] as Array<[string, string]>,
    };
    for (let s = 0; s < 200; s++) {
      expect(decideAmbient('revive', s, shuffled)).toEqual(decideAmbient('revive', s, pool));
    }
  });

  it('fires at the rate the 30-70 s timer averaged: ~0.4 per 20 s slot (mean one per 50 s)', () => {
    let fired = 0;
    for (let s = 0; s < 5000; s++) if (decideAmbient('revive', s, pool).kind !== 'none') fired++;
    expect(fired / 5000).toBeGreaterThan(0.36);
    expect(fired / 5000).toBeLessThan(0.44);
  });

  it('keeps the category split: ~35% pet, then ~22% pair among the rest, else a member', () => {
    let pet = 0, pair = 0, member = 0;
    for (let s = 0; s < 10_000; s++) {
      const d = decideAmbient('revive', s, pool);
      if (d.kind === 'pet') pet++;
      else if (d.kind === 'pair') pair++;
      else if (d.kind === 'member') member++;
    }
    const fired = pet + pair + member;
    expect(pet / fired).toBeGreaterThan(0.31);
    expect(pet / fired).toBeLessThan(0.39);
    expect(pair / (pair + member)).toBeGreaterThan(0.18);
    expect(pair / (pair + member)).toBeLessThan(0.26);
  });

  it('spreads member picks across the whole pool', () => {
    const counts = new Map<string, number>();
    for (let s = 0; s < 10_000; s++) {
      const d = decideAmbient('revive', s, pool);
      if (d.kind === 'member') counts.set(d.who, (counts.get(d.who) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(pool.members);
  });

  it('never picks a pair when the pool has none, and no beat at all from an empty room', () => {
    for (let s = 0; s < 500; s++) {
      const d = decideAmbient('revive', s, { members: ['ada'], pairs: [] });
      expect(d.kind === 'pair').toBe(false);
      expect(decideAmbient('revive', s, { members: [], pairs: [] })).toEqual({ kind: 'none' });
    }
  });
});
