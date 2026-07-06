import { describe, expect, it } from 'vitest';
import { DESK_SLOTS, HUDDLES, NOOK } from './layout';
import { findPath, walkable } from './nav';

describe('walkability grid', () => {
  it('blocks furniture but keeps rugs walkable', () => {
    // a desk slab is solid
    expect(walkable(DESK_SLOTS[0]!.lx, DESK_SLOTS[0]!.ly)).toBe(false);
    // the huddle's low table is solid, but its rug (south of the poufs) is floor
    const h = HUDDLES[0]!;
    expect(walkable(h.lx, h.ly)).toBe(false);
    expect(walkable(h.lx, h.ly + 70)).toBe(true);
    // the nook couch is solid; the open rug in front of the away arc is floor
    expect(walkable(NOOK.lx + 34, NOOK.ly - 2)).toBe(false);
    expect(walkable(NOOK.lx - 40, NOOK.ly + 130)).toBe(true);
  });

  it('routes around a desk instead of through it', () => {
    // straight across desk 0 (150,150): the path must detour, and every step must be clear
    const slot = DESK_SLOTS[0]!;
    const from = { lx: slot.lx, ly: slot.ly + 90 };
    const to = { lx: slot.lx, ly: slot.ly - 90 };
    const path = findPath(from, to);
    expect(path.length).toBeGreaterThan(2); // waypoints, not a straight glide
    expect(path[0]).toEqual(from);
    expect(path[path.length - 1]).toEqual(to);
    // sample each segment: nothing but (possibly) the exact endpoints may cross a solid cell
    for (let i = 1; i < path.length - 2; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const steps = Math.ceil(Math.hypot(b.lx - a.lx, b.ly - a.ly) / 5);
      for (let sIdx = 0; sIdx <= steps; sIdx++) {
        const t = sIdx / steps;
        expect(walkable(a.lx + (b.lx - a.lx) * t, a.ly + (b.ly - a.ly) * t)).toBe(true);
      }
    }
  });

  it('returns a plain segment when the straight line is already clear', () => {
    const from = { lx: 60, ly: 290 };
    const to = { lx: 60, ly: 400 };
    expect(findPath(from, to)).toEqual([from, to]);
  });

  it('detours around another member standing mid-route', () => {
    const from = { lx: 60, ly: 290 };
    const to = { lx: 60, ly: 430 };
    const path = findPath(from, to, [{ lx: 60, ly: 360 }]);
    expect(path.length).toBeGreaterThan(2);
    // and softened avoidance never blocks the endpoints themselves
    const near = findPath(from, to, [{ lx: from.lx, ly: from.ly + 10 }, { lx: to.lx, ly: to.ly }]);
    expect(near[0]).toEqual(from);
    expect(near[near.length - 1]).toEqual(to);
  });

  it('starts and ends exactly at endpoints even when they sit inside furniture (a desk seat)', () => {
    const slot = DESK_SLOTS[0]!; // S-facing: the seat is just north of the slab, inside the inflated zone
    const seat = { lx: slot.lx, ly: slot.ly - 40 };
    const out = { lx: slot.lx, ly: slot.ly + 120 };
    const path = findPath(seat, out);
    expect(path[0]).toEqual(seat);
    expect(path[path.length - 1]).toEqual(out);
  });
});
