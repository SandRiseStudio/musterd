import { describe, expect, it } from 'vitest';
import { FLOOR, project } from './iso';
import {
  BOOKSHELVES,
  DESK_D,
  DESK_SLOTS,
  DESK_W,
  FWD,
  LEISURE_SPOTS,
  MEETING,
  MIN_SPOT_GAP,
  PODS,
  RECEPTION,
  SEAT_BACK,
  SHELF_DEEP,
} from './layout';

describe('desk pods', () => {
  it('gives every pod four desks, with stable unique ids', () => {
    expect(DESK_SLOTS).toHaveLength(PODS.length * 4);
    expect(new Set(DESK_SLOTS.map((s) => s.id)).size).toBe(DESK_SLOTS.length);
    for (const pod of PODS) {
      expect(DESK_SLOTS.filter((s) => s.pod === pod.id)).toHaveLength(4);
    }
  });

  it('keeps exactly two desks facing the viewer', () => {
    // A face is what makes a member read as a person rather than a coloured block, so the floor needs
    // some — but turning more of it toward the camera would make the room a stage set. Two is the deal:
    // one 'ns' pod's north row. Adding a second 'ns' pod would silently double it.
    expect(DESK_SLOTS.filter((s) => s.dir === 'S')).toHaveLength(2);
  });

  it('seats every member outside their pod, on the floor', () => {
    for (const slot of DESK_SLOTS) {
      const f = FWD[slot.dir];
      const seat = { lx: slot.lx - f[0] * SEAT_BACK, ly: slot.ly - f[1] * SEAT_BACK };
      const pod = PODS[slot.pod]!;
      // the seat is further from the pod centre than the desk is — i.e. the member sits on the outside,
      // backs to the aisle, not squeezed between their desk and the shared screen
      const deskGap = Math.hypot(slot.lx - pod.cx, slot.ly - pod.cy);
      expect(Math.hypot(seat.lx - pod.cx, seat.ly - pod.cy)).toBeGreaterThan(deskGap);
      for (const v of [seat.lx, seat.ly]) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(FLOOR);
      }
    }
  });

  it('never overlaps two desk slabs', () => {
    const box = (s: (typeof DESK_SLOTS)[number]) => {
      const sn = s.dir === 'S' || s.dir === 'N';
      const w = sn ? DESK_W : DESK_D;
      const d = sn ? DESK_D : DESK_W;
      return { x0: s.lx - w / 2, x1: s.lx + w / 2, y0: s.ly - d / 2, y1: s.ly + d / 2 };
    };
    for (let i = 0; i < DESK_SLOTS.length; i++) {
      for (let j = i + 1; j < DESK_SLOTS.length; j++) {
        const a = box(DESK_SLOTS[i]!);
        const b = box(DESK_SLOTS[j]!);
        expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
      }
    }
  });
});

describe('zone rugs', () => {
  it('keeps every rug on the floor slab', () => {
    // A rug that runs past the floor edge paints over the slab's side face and the room looks torn.
    const rugs = [
      { lx: MEETING.lx, ly: MEETING.ly, w: MEETING.rug.w, d: MEETING.rug.d },
      { lx: RECEPTION.rug.lx, ly: RECEPTION.rug.ly, w: RECEPTION.rug.w, d: RECEPTION.rug.d },
    ];
    for (const r of rugs) {
      expect(r.lx - r.w / 2).toBeGreaterThanOrEqual(0);
      expect(r.ly - r.d / 2).toBeGreaterThanOrEqual(0);
      expect(r.lx + r.w / 2).toBeLessThanOrEqual(FLOOR);
      expect(r.ly + r.d / 2).toBeLessThanOrEqual(FLOOR);
    }
  });
});

describe('LEISURE_SPOTS', () => {
  it('keeps every pair of spots far enough apart to read as two people', () => {
    // The guard is in **screen** space, not floor space: the 2:1 iso halves the ly axis, so two spots can
    // be a comfortable 64 apart on the plan and 37 apart in pixels — one smeared avatar under two stacked
    // name labels. This is the check that keeps a spot from being added back into a pile.
    const fit = { ox: 0, oy: 0, scale: 1 };
    for (let i = 0; i < LEISURE_SPOTS.length; i++) {
      for (let j = i + 1; j < LEISURE_SPOTS.length; j++) {
        const a = LEISURE_SPOTS[i]!;
        const b = LEISURE_SPOTS[j]!;
        const pa = project(a.lx, a.ly, fit);
        const pb = project(b.lx, b.ly, fit);
        const gap = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        expect(
          gap,
          `${a.zone}[${i}] and ${b.zone}[${j}] are ${gap.toFixed(1)} apart on screen`,
        ).toBeGreaterThanOrEqual(MIN_SPOT_GAP);
      }
    }
  });

  it('offers every zone, so idle members spread instead of filling one corner', () => {
    for (const zone of ['lounge', 'huddle', 'meeting', 'reading']) {
      expect(LEISURE_SPOTS.some((s) => s.zone === zone)).toBe(true);
    }
  });

  it('interleaves zones, so a probe that collides lands in a different part of the room', () => {
    // Assignment is a hash + linear probe over this array (seating.ts). Grouped by zone, a collision
    // walks to the seat *next door* and the room clumps; interleaved, it lands across the floor.
    const firstFour = LEISURE_SPOTS.slice(0, 4).map((s) => s.zone);
    expect(new Set(firstFour).size).toBe(4);
  });

  it('keeps every spot on the floor', () => {
    for (const s of LEISURE_SPOTS) {
      expect(s.lx).toBeGreaterThan(0);
      expect(s.ly).toBeGreaterThan(0);
      expect(s.lx).toBeLessThan(FLOOR);
      expect(s.ly).toBeLessThan(FLOOR);
    }
  });
});

describe('BOOKSHELVES — flush to floor edges', () => {
  it('pins each shelf so its back sits on the perimeter (door-flush pattern)', () => {
    const half = SHELF_DEEP / 2;
    for (const s of BOOKSHELVES) {
      switch (s.dir) {
        case 'S':
          expect(s.ly).toBe(half);
          break;
        case 'N':
          expect(s.ly).toBe(FLOOR - half);
          break;
        case 'E':
          expect(s.lx).toBe(half);
          break;
        case 'W':
          expect(s.lx).toBe(FLOOR - half);
          break;
        default: {
          const _exhaustive: never = s.dir;
          throw new Error(`unexpected dir ${_exhaustive}`);
        }
      }
    }
  });
});
