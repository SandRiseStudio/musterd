import { DESK_SLOTS, ENTRANCE, FWD, NOOK, SEAT_BACK } from './layout';
import type { Placement } from './seating';
import type { Bubble, Dir, OfficeNode, Pose } from './types';

/**
 * The actor system: turns a live roster + acts into moving avatars. Every present member has a *home*
 * pose (their seat / nook / entrance-strip spot); acts that read as motion (`request_help`, `handoff`)
 * enqueue a **walk** — a short there-pause-back trip to a teammate's desk. Presence changes animate too:
 * a member who comes online **walks in from the entrance**, one who goes offline **walks out** and is
 * dropped at the door, and going away / coming back **drifts** between a desk and the break nook. Purely
 * positional (no Rive): distance sets duration, urgency runs it faster. Deterministic home layout mirrors
 * `renderScene`'s seating maths so labels/anchors line up exactly.
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
        alpha: 1,
        moving: false,
        run: false,
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
        alpha: 1,
        moving: false,
        run: false,
      });
    } else if (pl.kind === 'strip') {
      out.set(name, {
        lx: ENTRANCE.lx - 70 + (pl.index % 4) * 46,
        ly: ENTRANCE.ly - 92 - Math.floor(pl.index / 4) * 40,
        dir: 'N',
        small: true,
        carry: false,
        bubble: null,
        alpha: 1,
        moving: false,
        run: false,
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
  /** Door staging: fade the avatar in while entering / out while leaving; absent for act-walks & drifts. */
  fade?: 'in' | 'out';
  /** Urgent help walk — drives the `run` pose flag (Rive `run` modifier). */
  run?: boolean;
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
  /** Reconcile to a new roster: seat everyone, and (when `animate`) walk arrivals in, departures out,
   * and away/return drifts between desk and nook. The first call just snaps (no entrance stampede). */
  setHomes(placements: Map<string, Placement>, byName: Map<string, OfficeNode>, animate: boolean): void;
  /** Enqueue a walk to a teammate. Returns false if it can't play (mover or target not present). */
  walk(from: string, req: Req): boolean;
  /** Advance all walks by dt seconds; returns true while any walk (act or transition) is in flight. */
  step(dt: number): boolean;
  /** The current pose of every drawn member (home, or interpolated if walking — incl. those leaving). */
  poses(): Map<string, Pose>;
  /** Nodes to draw this frame — the live roster plus any members currently walking out. */
  nodes(): Map<string, OfficeNode>;
  /** How many members entered or left since the last call (clears) — drives the door-open glow. */
  takeDoorPulses(): number;
  active(): boolean;
}

export function createActors(): Actors {
  let homes = new Map<string, Pose>();
  let live = new Map<string, OfficeNode>();
  const ghosts = new Map<string, OfficeNode>(); // members walking out — dropped when they reach the door
  const walks = new Map<string, Walk>();
  const pending = new Map<string, Req[]>();
  const exiting = new Set<string>();
  let initialized = false;
  let doorPulses = 0; // members that entered/left since the last takeDoorPulses()

  function entrancePose(ref: Pose): Pose {
    return { lx: ENTRANCE.lx, ly: ENTRANCE.ly, dir: 'N', small: ref.small, carry: false, bubble: null, alpha: 1, moving: false, run: false };
  }
  function moved(a: Pose, b: Pose): boolean {
    return Math.hypot(a.lx - b.lx, a.ly - b.ly) > 8;
  }
  /** A one-leg point-to-point walk (entrance-in, drift, or leave), optionally fading at the door. */
  function straightWalk(from: Pose, to: Pose, exit: boolean, fade?: 'in' | 'out'): Walk {
    const speed = 78; // logical units/sec — an unhurried stroll across the floor
    const dur = clamp(Math.hypot(to.lx - from.lx, to.ly - from.ly) / speed, 1.8, 6);
    return {
      legs: [
        {
          fx: from.lx,
          fy: from.ly,
          tx: to.lx,
          ty: to.ly,
          dir: travelDir(from.lx, from.ly, to.lx, to.ly),
          dur,
          carry: false,
          bubble: null,
        },
      ],
      i: 0,
      t: 0,
      small: exit ? from.small : to.small,
      ...(fade ? { fade } : {}),
    };
  }

  function posesNow(): Map<string, Pose> {
    const out = new Map<string, Pose>();
    for (const [n, p] of homes) out.set(n, { ...p });
    for (const [name, w] of walks) {
      const leg = w.legs[w.i]!;
      const e = easeInOut(clamp(w.t, 0, 1));
      // Door fade: emerge over the first third entering, dissolve over the last third leaving.
      const alpha =
        w.fade === 'in' ? clamp(w.t / 0.35, 0, 1) : w.fade === 'out' ? clamp((1 - w.t) / 0.35, 0, 1) : 1;
      out.set(name, {
        lx: leg.fx + (leg.tx - leg.fx) * e,
        ly: leg.fy + (leg.ty - leg.fy) * e,
        dir: leg.dir,
        small: w.small,
        carry: leg.carry,
        bubble: leg.bubble,
        alpha,
        // Travelling (not the hold leg) → `walking`; urgent walks → `run`.
        moving: leg.fx !== leg.tx || leg.fy !== leg.ty,
        run: w.run ?? false,
      });
    }
    return out;
  }

  function build(from: string, req: Req): Walk | null {
    const home = homes.get(from);
    const target = homes.get(req.to);
    if (!home || !target) return null;
    const a = approach(target, home);
    const speed = req.urgent ? 165 : 100; // logical units / sec — amble over, or hurry when urgent
    const dur = (fx: number, fy: number, tx: number, ty: number): number =>
      clamp(Math.hypot(tx - fx, ty - fy) / speed, 1.4, 4.5);
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
      run: req.urgent,
    };
  }

  function startNext(from: string): void {
    if (exiting.has(from)) return;
    const q = pending.get(from);
    if (!q || q.length === 0) return;
    let w: Walk | null = null;
    while (q.length && !w) w = build(from, q.shift()!);
    if (w) walks.set(from, w);
  }

  return {
    setHomes(placements, byName, animate) {
      const newHomes = homePoses(placements, byName);
      const prevHomes = homes;
      const prevLive = live;
      const cur = posesNow(); // capture current positions before we swap homes
      homes = newHomes;
      live = byName;

      if (!initialized || !animate) {
        // First paint (or reduced-motion): snap — no entrance stampede, no frozen mid-walks.
        initialized = true;
        walks.clear();
        pending.clear();
        exiting.clear();
        ghosts.clear();
        return;
      }

      // Arrivals (walk in from the door, fading in) and drifts (desk ⇄ nook / reseat).
      for (const [name, dest] of newHomes) {
        if (!prevHomes.has(name)) {
          exiting.delete(name);
          ghosts.delete(name);
          walks.set(name, straightWalk(entrancePose(dest), dest, false, 'in'));
          doorPulses++;
        } else if (!exiting.has(name)) {
          const from = cur.get(name) ?? prevHomes.get(name)!;
          if (moved(from, dest)) walks.set(name, straightWalk(from, dest, false));
        }
      }
      // Departures (walk out to the door, fading out, then vanish).
      for (const [name, prevHome] of prevHomes) {
        if (newHomes.has(name)) continue;
        const from = cur.get(name) ?? prevHome;
        const node = prevLive.get(name);
        if (node) ghosts.set(name, node);
        pending.delete(name);
        exiting.add(name);
        walks.set(name, straightWalk(from, entrancePose(from), true, 'out'));
        doorPulses++;
      }
    },
    walk(from, req) {
      if (!homes.has(from) || !homes.has(req.to) || from === req.to || exiting.has(from)) return false;
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
            if (exiting.has(name)) {
              exiting.delete(name);
              ghosts.delete(name);
            } else {
              startNext(name);
            }
          }
        }
      }
      return walks.size > 0;
    },
    poses: posesNow,
    nodes() {
      const out = new Map<string, OfficeNode>(ghosts);
      for (const [n, node] of live) out.set(n, node);
      return out;
    },
    takeDoorPulses() {
      const n = doorPulses;
      doorPulses = 0;
      return n;
    },
    active() {
      return walks.size > 0;
    },
  };
}
