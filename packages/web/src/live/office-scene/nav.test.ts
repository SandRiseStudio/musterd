import { describe, expect, it } from 'vitest';
import { DESK_SLOTS, ENTRANCE, FWD, HUDDLES, NOOK, NOOK_RUG_R, NOOK_SPOTS, SEAT_BACK } from './layout';
import { findPath, walkable } from './nav';

describe('the floor plan stays navigable', () => {
  it('leaves every desk seat standable and reachable from the door', () => {
    // The guard that matters when the floor plan changes: a new zone (a rug's furniture, a
    // plant) dropped on the wrong spot can fence a pod off or land on top of a seat, and nothing else in
    // the scene would fail — the member would just glide through the wall to a chair inside a table.
    for (const slot of DESK_SLOTS) {
      const f = FWD[slot.dir];
      const seat = { lx: slot.lx - f[0] * SEAT_BACK, ly: slot.ly - f[1] * SEAT_BACK };
      // every pod backs onto an aisle: the floor behind the seat is open, so a member can push the chair
      // back and stand. (Measured a chair's depth clear of the seat — nearer than that and the coarse
      // grid just reports the chair's own padded footprint, which tells you nothing.)
      expect(walkable(seat.lx - f[0] * 60, seat.ly - f[1] * 60)).toBe(true);

      const path = findPath(ENTRANCE, seat);
      expect(path.length).toBeGreaterThan(1);
      // every waypoint but the last (the seat itself, inside the chair's footprint) is real open floor;
      // a degenerate straight glide through the furniture would fail here
      for (const p of path.slice(0, -1)) expect(walkable(p.lx, p.ly)).toBe(true);
    }
  });
});

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

  it('stands every away member on open rug — clear of the lounge furniture', () => {
    for (const s of NOOK_SPOTS) {
      const lx = NOOK.lx + s.dx;
      const ly = NOOK.ly + s.dy;
      expect(walkable(lx, ly)).toBe(true); // not inside couch/chairs/table/kitchenette
      expect(Math.abs(s.dx) + Math.abs(s.dy)).toBeLessThan(NOOK_RUG_R); // on the rug
    }
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
