import { describe, expect, it } from 'vitest';
import {
  FRONT_DESK,
  CHECK_IN_MARKS,
  COFFEE_STAND,
  COOLER_STAND,
  DESK_SLOTS,
  ENTRANCE,
  FRIDGE_STAND,
  FWD,
  LEISURE_SPOTS,
  NOOK,
  NOOK_RUG_R,
  NOOK_SPOTS,
  RECEPTION,
  SEAT_BACK,
  SINK_STAND,
} from './layout';
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
    // reception's waiting chair is solid, but the rug it stands on is floor
    expect(walkable(RECEPTION.chairA.lx, RECEPTION.chairA.ly)).toBe(false);
    expect(walkable(RECEPTION.rug.lx - 90, RECEPTION.rug.ly)).toBe(true);
    // the nook couch is solid; the open rug in front of the away arc is floor
    expect(walkable(NOOK.lx + 34, NOOK.ly - 2)).toBe(false);
    expect(walkable(NOOK.lx - 58, NOOK.ly + 78)).toBe(true);
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

/**
 * Nobody walks through the furniture.
 *
 * The older guard above checks that each *waypoint* is on open floor, which a two-point straight glide
 * passes trivially: its only waypoints are the endpoints. That is how the real bug hid — `findPath`
 * returned `[from, to]` whenever A* failed, and a member strolled the length of the room through a
 * meeting table. These walk the segments instead.
 *
 * Sampling tolerance: footprints are inflated by the body radius, so a line clipping a cell corner by a
 * unit or two leaves the drawn body still clear of the drawn furniture. What must never happen is real
 * penetration — a *run* of blocked samples. `MAX_GRAZE` is the width of the run we forgive.
 */
const SAMPLE = 2;
const MAX_GRAZE = 6;

/**
 * The longest unbroken run of blocked samples *in the interior* of a route, in logical units.
 *
 * Runs touching either end are excluded rather than measured: a trip legitimately starts inside the
 * desk you are getting up from and ends inside the chair you are sitting down on. Only a stretch that
 * begins and ends on open floor is a walker passing through something.
 */
function deepestPenetration(path: { lx: number; ly: number }[]): number {
  let worst = 0;
  let run = 0;
  let seenFree = false;
  for (let s = 0; s < path.length - 1; s++) {
    const a = path[s]!;
    const b = path[s + 1]!;
    const d = Math.hypot(b.lx - a.lx, b.ly - a.ly);
    const steps = Math.max(1, Math.ceil(d / SAMPLE));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (walkable(a.lx + (b.lx - a.lx) * t, a.ly + (b.ly - a.ly) * t)) {
        // The run just ended on open floor — it was interior, so it counts.
        if (seenFree) worst = Math.max(worst, run);
        run = 0;
        seenFree = true;
      } else if (seenFree) {
        run += d / steps;
      }
    }
  }
  return worst; // any run still open at the end touches the destination — not a pass-through
}

describe('routes never pass through furniture', () => {
  const errands: [string, { lx: number; ly: number }][] = [
    ['fridge', FRIDGE_STAND],
    ['cooler', COOLER_STAND],
    ['sink', SINK_STAND],
    ['coffee', COFFEE_STAND],
  ];

  it('from every desk to every errand stand point', () => {
    const bad: string[] = [];
    for (const slot of DESK_SLOTS) {
      for (const [name, to] of errands) {
        const deep = deepestPenetration(findPath({ lx: slot.lx, ly: slot.ly }, to));
        if (deep > MAX_GRAZE) bad.push(`desk ${slot.id} → ${name}: ${deep.toFixed(0)} units through solid`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('between every offered leisure spot and the kitchenette', () => {
    const bad: string[] = [];
    for (let i = 0; i < LEISURE_SPOTS.length; i++) {
      const s = LEISURE_SPOTS[i]!;
      const there = deepestPenetration(findPath(FRIDGE_STAND, { lx: s.lx, ly: s.ly }));
      const back = deepestPenetration(findPath({ lx: s.lx, ly: s.ly }, SINK_STAND));
      const deep = Math.max(there, back);
      if (deep > MAX_GRAZE) bad.push(`spot ${i} (${s.zone}): ${deep.toFixed(0)} units through solid`);
    }
    expect(bad).toEqual([]);
  });

  it('offers no seat without open floor beside it', () => {
    // Every route's last leg steps from open floor onto the cushion, and that step is the one segment
    // allowed to cross a footprint — it is what sitting down *is*. It stays a step rather than a slide
    // only while the seat has walkable floor near it. The meeting table's south chairs did not: walled
    // in by the table on one side and the floor's edge on the other, the nearest floor a body could
    // stand on was 140 units away, and "sitting down" became a walk through the table.
    const bad: string[] = [];
    for (let i = 0; i < LEISURE_SPOTS.length; i++) {
      const s = LEISURE_SPOTS[i]!;
      let nearest = Infinity;
      for (let a = 0; a < 16; a++) {
        for (const r of [30, 45, 60]) {
          const th = (a / 16) * Math.PI * 2;
          const lx = s.lx + Math.cos(th) * r;
          const ly = s.ly + Math.sin(th) * r;
          if (walkable(lx, ly)) nearest = Math.min(nearest, r);
        }
      }
      // A chair seats its occupant ~`CHAIR_OFF` back from where they stood to sit, so floor within 60
      // is what a real approach looks like.
      if (nearest === Infinity) bad.push(`spot ${i} (${s.zone}): no walkable floor within 60 units`);
    }
    expect(bad).toEqual([]);
  });
});

describe('the front desk blocks', () => {
  it('routes an arrival around the counter, never through it', () => {
    const path = findPath({ lx: ENTRANCE.lx, ly: ENTRANCE.ly }, { lx: DESK_SLOTS[0]!.lx, ly: DESK_SLOTS[0]!.ly - 60 }, []);
    for (const step of path) {
      const inDesk =
        Math.abs(step.lx - FRONT_DESK.lx) < FRONT_DESK.long / 2 &&
        Math.abs(step.ly - FRONT_DESK.ly) < FRONT_DESK.deep / 2;
      expect(inDesk).toBe(false);
    }
  });

  it('keeps the check-in marks on walkable floor', () => {
    // A mark inside a blocked cell would get nudged by nearestFree and the pause would land somewhere
    // other than in front of the desk. The receptionist deliberately is NOT held to this: she stands
    // inside the counter's padded footprint (that is what "behind the desk" means to the nav grid),
    // and she never walks, so the grid owes her nothing.
    for (const m of CHECK_IN_MARKS) expect(walkable(m.lx, m.ly), `mark ${m.lx},${m.ly}`).toBe(true);
  });
});
