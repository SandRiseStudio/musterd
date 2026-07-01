import { DESK_SLOTS, ENTRANCE, FWD, NOOK, SEAT_BACK } from './layout';
import type { Placement } from './seating';
import type { Bubble, Dir, OfficeNode, Pose } from './types';

/**
 * The actor system: turns a live roster + acts into moving avatars. Every present member has a *home*
 * pose (their seat / nook / entrance-strip spot); acts that read as motion (`request_help`, `handoff`)
 * enqueue a **walk** — a short there-pause-back trip to a teammate's desk — that the scene interpolates
 * each frame. Purely positional (no Rive): distance sets duration, urgency runs it faster. Deterministic
 * home layout mirrors `renderScene`'s old seating maths so labels/anchors line up exactly.
 */

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Face the direction of travel from (fx,fy) → (tx,ty) in logical space. */
export function travelDir(fx: number, fy: number, tx: number, ty: number): Dir {
  const dx = tx - fx;
  const dy = ty - fy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'E' : 'W';
  return dy >= 0 ? 'S' : 'N';
}

/** The deterministic home pose of every present member (desk / nook / strip). Gone members are absent. */
export function homePoses(
  placements: Map<string, Placement>,
  byName: Map<string, OfficeNode>,
): Map<string, Pose> {
  const out = new Map<string, Pose>();
  const nook = [...placements.entries()]
    .filter(([, p]) => p.kind === 'nook')
    .map(([n]) => n)
    .sort();
  for (const [name, pl] of placements) {
    if (!byName.has(name)) continue;
    if (pl.kind === 'desk') {
      const slot = DESK_SLOTS[pl.slot];
      if (!slot) continue;
      const f = FWD[slot.dir];
      out.set(name, {
        lx: slot.lx - f[0] * SEAT_BACK,
        ly: slot.ly - f[1] * SEAT_BACK,
        dir: slot.dir,
        small: false,
        carry: false,
        bubble: null,
      });
    } else if (pl.kind === 'nook') {
      const i = nook.indexOf(name);
      out.set(name, {
        lx: NOOK.lx - 40 + (i % 3) * 40,
        ly: NOOK.ly + 44 + Math.floor(i / 3) * 34,
        dir: 'S',
        small: true,
        carry: false,
        bubble: null,
      });
    } else if (pl.kind === 'strip') {
      out.set(name, {
        lx: ENTRANCE.lx - 70 + (pl.index % 4) * 46,
        ly: ENTRANCE.ly - 92 - Math.floor(pl.index / 4) * 40,
        dir: 'N',
        small: true,
        carry: false,
        bubble: null,
      });
    }
  }
  return out;
}

interface Leg {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  dir: Dir;
  dur: number;
  carry: boolean;
  bubble: Bubble;
}
interface Walk {
  legs: Leg[];
  i: number;
  t: number;
  small: boolean;
}
type Req = { kind: 'help' | 'handoff'; to: string; urgent: boolean };

/** A point ~offset in front of `target`, on the side facing `mover` — where a visitor stands. */
function approach(target: Pose, mover: Pose): { lx: number; ly: number } {
  const dx = mover.lx - target.lx;
  const dy = mover.ly - target.ly;
  const d = Math.hypot(dx, dy) || 1;
  const off = clamp(d * 0.4, 46, 72);
  return { lx: target.lx + (dx / d) * off, ly: target.ly + (dy / d) * off };
}

export interface Actors {
  setHomes(placements: Map<string, Placement>, byName: Map<string, OfficeNode>): void;
  /** Enqueue a walk to a teammate. Returns false if it can't play (mover or target not present). */
  walk(from: string, req: Req): boolean;
  /** Advance all walks by dt seconds; returns true while any walk is in flight. */
  step(dt: number): boolean;
  /** The current pose of every present member (home, or interpolated if walking). */
  poses(): Map<string, Pose>;
  active(): boolean;
}

export function createActors(): Actors {
  let homes = new Map<string, Pose>();
  const walks = new Map<string, Walk>();
  const pending = new Map<string, Req[]>();

  function build(from: string, req: Req): Walk | null {
    const home = homes.get(from);
    const target = homes.get(req.to);
    if (!home || !target) return null;
    const a = approach(target, home);
    const speed = req.urgent ? 620 : 360; // logical units / sec
    const dur = (fx: number, fy: number, tx: number, ty: number): number =>
      clamp(Math.hypot(tx - fx, ty - fy) / speed, 0.35, 1.6);
    const carry = req.kind === 'handoff';
    const hold = req.kind === 'help' ? (req.urgent ? 0.5 : 0.75) : 0.6;
    const holdBubble: Bubble = req.kind === 'help' ? (req.urgent ? '!' : '?') : null;
    return {
      legs: [
        { fx: home.lx, fy: home.ly, tx: a.lx, ty: a.ly, dir: travelDir(home.lx, home.ly, a.lx, a.ly), dur: dur(home.lx, home.ly, a.lx, a.ly), carry, bubble: null },
        { fx: a.lx, fy: a.ly, tx: a.lx, ty: a.ly, dir: travelDir(a.lx, a.ly, target.lx, target.ly), dur: hold, carry, bubble: holdBubble },
        { fx: a.lx, fy: a.ly, tx: home.lx, ty: home.ly, dir: travelDir(a.lx, a.ly, home.lx, home.ly), dur: dur(a.lx, a.ly, home.lx, home.ly), carry: false, bubble: null },
      ],
      i: 0,
      t: 0,
      small: home.small,
    };
  }

  function startNext(from: string): void {
    const q = pending.get(from);
    if (!q || q.length === 0) return;
    let w: Walk | null = null;
    while (q.length && !w) w = build(from, q.shift()!);
    if (w) walks.set(from, w);
  }

  return {
    setHomes(placements, byName) {
      homes = homePoses(placements, byName);
      for (const name of [...walks.keys()]) if (!homes.has(name)) walks.delete(name);
      for (const name of [...pending.keys()]) if (!homes.has(name)) pending.delete(name);
    },
    walk(from, req) {
      if (!homes.has(from) || !homes.has(req.to) || from === req.to) return false;
      const q = pending.get(from) ?? [];
      if (q.length >= 3) return false; // cap the backlog so a chatty pair doesn't march forever
      q.push(req);
      pending.set(from, q);
      if (!walks.has(from)) startNext(from);
      return true;
    },
    step(dt) {
      for (const [name, w] of [...walks.entries()]) {
        const leg = w.legs[w.i]!;
        w.t += dt / leg.dur;
        if (w.t >= 1) {
          w.t = 0;
          w.i++;
          if (w.i >= w.legs.length) {
            walks.delete(name);
            startNext(name);
          }
        }
      }
      return walks.size > 0;
    },
    poses() {
      const out = new Map<string, Pose>();
      for (const [n, p] of homes) out.set(n, { ...p });
      for (const [name, w] of walks) {
        const leg = w.legs[w.i]!;
        const e = easeInOut(clamp(w.t, 0, 1));
        out.set(name, {
          lx: leg.fx + (leg.tx - leg.fx) * e,
          ly: leg.fy + (leg.ty - leg.fy) * e,
          dir: leg.dir,
          small: w.small,
          carry: leg.carry,
          bubble: leg.bubble,
        });
      }
      return out;
    },
    active() {
      return walks.size > 0;
    },
  };
}
