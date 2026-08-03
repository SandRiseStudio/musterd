import { describe, expect, it } from 'vitest';
import { FLOOR, project, WALL_H } from './iso';
import {
  ART,
  CHECK_IN_MARKS,
  FRONT_DESK,
  RECEPTIONIST,
  BOOKSHELVES,
  DESK_D,
  DESK_SLOTS,
  DESK_W,
  ENTRANCE,
  STRIP_CAP,
  FWD,
  LEISURE_SPOTS,
  MEETING,
  MIN_SPOT_GAP,
  PODS,
  RECEPTION,
  SEAT_BACK,
  WALL_BOARD,
  WINDOWS,
  BENCH,
  WINDOW_DESKS,
} from './layout';

describe('desk pods', () => {
  it('seats exactly eighteen, sized per pod, with stable unique ids', () => {
    // 20 on 2026-08-02, 18 on 2026-08-03: the centre duo came out because the floor read as crowded,
    // and two seats bought more air than any amount of shuffling had.
    expect(DESK_SLOTS).toHaveLength(18);
    const podSeats = PODS.reduce((n, p) => n + p.size, 0);
    expect(DESK_SLOTS).toHaveLength(podSeats + BENCH.seats + WINDOW_DESKS.length);
    expect(new Set(DESK_SLOTS.map((s) => s.id)).size).toBe(DESK_SLOTS.length);
    for (const pod of PODS) {
      expect(DESK_SLOTS.filter((s) => s.pod === pod.id)).toHaveLength(pod.size);
    }
    expect(DESK_SLOTS.filter((s) => s.kind === 'bench')).toHaveLength(BENCH.seats);
    expect(DESK_SLOTS.filter((s) => s.kind === 'window')).toHaveLength(WINDOW_DESKS.length);
    // Pod ids stay 0..11 — the bench and window seats append, they do not renumber anybody.
    for (const s of DESK_SLOTS) if (s.kind === 'pod') expect(s.id).toBeLessThan(PODS.length * 4);
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
      for (const v of [seat.lx, seat.ly]) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(FLOOR);
      }
      if (slot.kind !== 'pod') continue; // bench/window seats have no pod centre to sit outside of
      const pod = PODS[slot.pod]!;
      // the seat is further from the pod centre than the desk is — i.e. the member sits on the outside,
      // backs to the aisle, not squeezed between their desk and the shared screen
      const deskGap = Math.hypot(slot.lx - pod.cx, slot.ly - pod.cy);
      expect(Math.hypot(seat.lx - pod.cx, seat.ly - pod.cy)).toBeGreaterThan(deskGap);
    }
  });

  it('never overlaps two desk slabs', () => {
    // Per-kind footprints: a bench seat owns its stretch of the shared counter, a window desk is a
    // full workstation turned 'ew'. Sizing everything as a pod desk would report the counter's four
    // abutting segments as a pileup.
    const box = (s: (typeof DESK_SLOTS)[number]) => {
      const sn = s.dir === 'S' || s.dir === 'N';
      const w = s.kind === 'bench' ? BENCH.long / BENCH.seats - 1 : sn ? DESK_W : DESK_D;
      const d = s.kind === 'bench' ? BENCH.deep : sn ? DESK_D : DESK_W;
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
    for (const zone of ['lounge', 'waiting', 'meeting', 'reading']) {
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

describe('the front desk', () => {
  it('sits near the entrance, facing arrivals', () => {
    expect(Math.hypot(FRONT_DESK.lx - ENTRANCE.lx, FRONT_DESK.ly - ENTRANCE.ly)).toBeLessThan(260);
  });

  it('does not sit on the overflow queue strip', () => {
    for (let i = 0; i < STRIP_CAP; i++) {
      const qx = ENTRANCE.lx + 34 + i * 32;
      const qy = ENTRANCE.ly - 10 - i * 6;
      const inDesk =
        Math.abs(qx - FRONT_DESK.lx) < FRONT_DESK.long / 2 &&
        Math.abs(qy - FRONT_DESK.ly) < FRONT_DESK.deep / 2;
      expect(inDesk).toBe(false);
    }
  });

  it('puts the receptionist behind the counter and the marks in front of it', () => {
    expect(CHECK_IN_MARKS.length).toBeGreaterThanOrEqual(3);
    for (const m of CHECK_IN_MARKS) {
      expect(Math.sign(m.ly - FRONT_DESK.ly)).not.toBe(Math.sign(RECEPTIONIST.ly - FRONT_DESK.ly));
    }
  });

  it('occludes the receptionist with the counter, not the other way round', () => {
    // Depth is lx+ly: the greater sum paints later, in front. A receptionist painted OVER her own
    // desk reads as standing on it.
    expect(RECEPTIONIST.lx + RECEPTIONIST.ly).toBeLessThan(FRONT_DESK.lx + FRONT_DESK.ly);
  });
});

describe('the walls are not a matched set', () => {
  it('hangs six pieces of art, varied in size and shape', () => {
    expect(ART).toHaveLength(6);
    expect(new Set(ART.map((a) => `${a.w}x${a.h}`)).size).toBeGreaterThan(3);
    expect(ART.some((a) => a.w > a.h)).toBe(true); // landscape
    expect(ART.some((a) => a.h > a.w)).toBe(true); // portrait
    expect(ART.some((a) => a.w === a.h)).toBe(true); // square
  });

  it('varies motif and frame treatment, including one unframed', () => {
    expect(new Set(ART.map((a) => a.motif)).size).toBeGreaterThan(2);
    expect(new Set(ART.map((a) => a.frame)).size).toBeGreaterThan(1);
    expect(ART.some((a) => a.frame === 'none')).toBe(true);
  });

  it('puts art on both walls', () => {
    expect(ART.some((a) => a.wall === 0)).toBe(true);
    expect(ART.some((a) => a.wall === 1)).toBe(true);
  });

  it('never hangs a picture over a window', () => {
    // Both back walls are mostly glass, so this is the constraint that decides where art can go at
    // all — and the first cut of the salon cluster failed it, hanging three pieces across the frame
    // of the near window. Half-widths are converted to `t` the same way `wallArt` does.
    for (const a of ART) {
      const half = a.w / 2 / FLOOR;
      for (const w of WINDOWS) {
        const overlaps = a.tc + half > w.t0 && a.tc - half < w.t1;
        expect(overlaps, `art (${a.motif} on wall ${a.wall} at t=${a.tc}) overlaps a window`).toBe(false);
      }
    }
  });

  it('never hangs a picture behind a bookshelf', () => {
    // A shelf occupies a `t` band on its wall and stands `high` units up it. If a picture shares that
    // band, its bottom edge has to clear the carcass AND whatever is standing on top of it — this
    // broke silently when the corner unit went from 66 to 88 tall and swallowed a print's lower third.
    const DECOR_UP = 22; // the tallest shelf-top object
    for (const a of ART) {
      const halfT = a.w / 2 / FLOOR;
      const bottom = a.uc * WALL_H - a.h / 2;
      for (const s of BOOKSHELVES) {
        // wall 0 is the lx=0 edge (t maps to ly); wall 1 is the ly=0 edge (t maps to lx)
        const onWall0 = s.dir === 'E';
        if ((a.wall === 0) !== onWall0) continue;
        const st = (onWall0 ? s.ly : s.lx) / FLOOR;
        const halfS = s.long / 2 / FLOOR;
        if (a.tc + halfT < st - halfS || a.tc - halfT > st + halfS) continue;
        expect(
          bottom,
          `art (${a.motif} at t=${a.tc}) hangs behind the ${s.high}-tall shelf at t=${st.toFixed(2)}`,
        ).toBeGreaterThan(s.high + DECOR_UP);
      }
    }
  });

  it('hangs the agile board clear of every window, the clock, the art, and the wall ends', () => {
    // The board holds the whiteboard's old slot widened into the wall's free far end — these are the
    // guards that earn it a home in layout.ts (the same rules the art lives by). The clock's numbers
    // come from render.ts (`wallClock` R=25 at t 0.52): mirrored here as data because the draw call
    // doesn't export them, and drifting silently onto the clock is exactly what this test is for.
    const half = WALL_BOARD.w / 2 / FLOOR;
    const t0 = WALL_BOARD.tc - half;
    const t1 = WALL_BOARD.tc + half;
    expect(t0).toBeGreaterThan(0);
    expect(t1).toBeLessThanOrEqual(1);
    for (const w of WINDOWS) {
      expect(t1 <= w.t0 || t0 >= w.t1, `board (t ${t0.toFixed(3)}–${t1.toFixed(3)}) overlaps a window`).toBe(true);
    }
    const CLOCK = { tc: 0.52, r: 27.5 / FLOOR };
    expect(t0 > CLOCK.tc + CLOCK.r || t1 < CLOCK.tc - CLOCK.r).toBe(true);
    for (const a of ART.filter((p) => p.wall === WALL_BOARD.wall)) {
      const ah = a.w / 2 / FLOOR;
      expect(t1 <= a.tc - ah || t0 >= a.tc + ah, `board overlaps the ${a.motif} print`).toBe(true);
    }
    // Vertically: on the wall (u ∈ [0,1]), above the bookshelf line the art also respects.
    expect(WALL_BOARD.uc * WALL_H - WALL_BOARD.h / 2).toBeGreaterThan(0);
    expect(WALL_BOARD.uc * WALL_H + WALL_BOARD.h / 2).toBeLessThan(WALL_H);
  });

  it('does not make four copies of one window', () => {
    expect(new Set(WINDOWS.map((w) => w.mullions)).size).toBeGreaterThan(1);
    expect(WINDOWS.some((w) => w.sill)).toBe(true);
  });

  it('brightens toward one sun — a random ramp reads as broken glass, not sunlight', () => {
    const bright = WINDOWS.map((w) => w.bright);
    expect(new Set(bright).size).toBeGreaterThan(1);
    expect([...bright]).toEqual([...bright].sort((a, b) => b - a));
  });
});

describe('BOOKSHELVES — flush to floor edges', () => {
  it('pins each shelf so its back sits on the perimeter (door-flush pattern)', () => {
    for (const s of BOOKSHELVES) {
      // Per-shelf depth: the units are no longer one repeated box, so "flush" is measured against
      // each unit's own footprint rather than a shared constant.
      const half = s.deep / 2;
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

  it('is not a matched set — the units differ in size', () => {
    expect(new Set(BOOKSHELVES.map((s) => s.long)).size).toBeGreaterThan(1);
    expect(new Set(BOOKSHELVES.map((s) => s.high)).size).toBeGreaterThan(1);
  });

  it('scales the band count with the height, so a low unit is not a tall one squashed', () => {
    const byHeight = [...BOOKSHELVES].sort((a, b) => a.high - b.high);
    expect(byHeight[0]!.rows).toBeLessThan(byHeight[byHeight.length - 1]!.rows);
  });

  it('has exactly one shelved backwards, and it is on the right wall', () => {
    const reversed = BOOKSHELVES.filter((s) => s.reversed);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]!.dir).toBe('W');
  });

  it('gives every unit something for its top', () => {
    for (const s of BOOKSHELVES) expect(s.decor).toBeTruthy();
  });
});
