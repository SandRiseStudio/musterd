import { COFFEE_STAND, DESK_SLOTS, ENTRANCE, FWD, NOOK, NOOK_CAP, SEAT_BACK, STRIP_CAP } from './layout';
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
        gesture: 0,
        gestureT: 0,
      });
    } else if (pl.kind === 'nook') {
      const i = nook.indexOf(name);
      if (i >= NOOK_CAP) continue; // past the cap: represented by the "+N away" pill, not an avatar
      // A lounge cluster around the coffee table: a compact 3-wide grid, each row nudged sideways so it
      // reads as people gathered rather than a rigid line, and kept tight so it stays on the nook rug.
      const col = i % 3;
      const row = Math.floor(i / 3);
      out.set(name, {
        lx: NOOK.lx - 42 + col * 42 + row * 16,
        ly: NOOK.ly + 40 + row * 28,
        dir: 'S',
        small: true,
        carry: false,
        bubble: null,
        alpha: 1,
        moving: false,
        run: false,
        gesture: 0,
        gestureT: 0,
      });
    } else if (pl.kind === 'strip') {
      if (pl.index >= STRIP_CAP) continue; // past the cap: represented by the "+N waiting" pill
      // Overflow past the 12 desks: a single-file queue receding from the entrance into the room, facing
      // the desks — reads as "waiting to be seated" rather than a floating grid stacked off the edge.
      out.set(name, {
        lx: ENTRANCE.lx - 34 + pl.index * 30,
        ly: ENTRANCE.ly - 56 - pl.index * 28,
        dir: 'N',
        small: true,
        carry: false,
        bubble: null,
        alpha: 1,
        moving: false,
        run: false,
        gesture: 0,
        gestureT: 0,
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
  /** A self-generated ambient beat (coffee-stroll), not a real act — runs at a capped idle FPS and
   * yields the instant a real act arrives (ADR 086 Phase 2). Carries no act semantics. */
  ambient?: boolean;
  /** The low-priority walk-home that `cancelAmbient` leaves behind when a stroll yields. Like `ambient`,
   * a real act for this member preempts it instantly rather than queuing behind it. */
  yield?: boolean;
}
type Req = { kind: 'help' | 'handoff'; to: string; urgent: boolean };

/** A point ~offset in front of `target`, on the side facing `mover` — where a visitor stands. */
function approach(target: { lx: number; ly: number }, mover: { lx: number; ly: number }): { lx: number; ly: number } {
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
  /** Enqueue an ambient coffee-stroll for a seated desk member (home → nook machine → pause → home).
   * Self-generated filler, not a real act; returns false if the member can't stroll (absent, in the
   * nook/queue, exiting, or already busy). See ADR 086 Phase 2. */
  ambientWalk(from: string): boolean;
  /** Play an in-place ambient gesture (`1` stretch · `2` glance) on a seated desk member for a short
   * window. Stationary filler, not a real act; returns false if the member can't gesture (absent, small,
   * exiting, walking, or already busy). See ADR 086 Phase 2 tail. */
  gestureBeat(from: string, kind: number): boolean;
  /** Seated desk members eligible to be sent on an ambient stroll right now (present, not small, idle). */
  idleDeskMembers(): string[];
  /** True when motion is in flight and *all* of it is ambient — drives the idle-FPS cap in the loop. */
  ambientOnly(): boolean;
  /** Preempt any in-flight ambient stroll, gracefully returning the walker home. Called the instant a
   * real act arrives so ambient never delays real choreography. */
  cancelAmbient(): void;
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
  // In-place ambient gestures (ADR 086 Phase 2 tail): a stationary beat (stretch/glance) overlaid on a
  // seated member's idle pose for a short window, then cleared. Parallel to `walks` — no movement, so it
  // keeps the loop alive (advance the Rive gesture layer) without a walk. `t` counts up to `dur` seconds.
  const gestures = new Map<string, { kind: number; t: number; dur: number }>();
  const exiting = new Set<string>();
  let initialized = false;
  let doorPulses = 0; // members that entered/left since the last takeDoorPulses()

  function entrancePose(ref: Pose): Pose {
    return { lx: ENTRANCE.lx, ly: ENTRANCE.ly, dir: 'N', small: ref.small, carry: false, bubble: null, alpha: 1, moving: false, run: false, gesture: 0, gestureT: 0 };
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
    // At-home members carry any active in-place gesture (a stationary ambient beat overlaid on idle),
    // plus its `0→1` window progress so the render can bob/sway the sprite in step with the beat.
    for (const [n, p] of homes) {
      const g = gestures.get(n);
      out.set(n, { ...p, gesture: g?.kind ?? p.gesture, gestureT: g ? clamp(g.t / g.dur, 0, 1) : 0 });
    }
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
        gesture: 0, // a walker never gestures — gestures are stationary idle beats
        gestureT: 0,
      });
    }
    return out;
  }

  function build(from: string, req: Req, origin?: { lx: number; ly: number }): Walk | null {
    const home = homes.get(from);
    const target = homes.get(req.to);
    if (!home || !target) return null;
    // A preempted stroll starts from where the avatar currently stands (not a snap back to the seat);
    // the return leg still homes to the seat. Normal act-walks start (and return) at the seat.
    const start = origin ?? home;
    const a = approach(target, start);
    const speed = req.urgent ? 165 : 100; // logical units / sec — amble over, or hurry when urgent
    const dur = (fx: number, fy: number, tx: number, ty: number): number =>
      clamp(Math.hypot(tx - fx, ty - fy) / speed, 1.4, 4.5);
    const carry = req.kind === 'handoff';
    const hold = req.kind === 'help' ? (req.urgent ? 0.5 : 0.75) : 0.6;
    const holdBubble: Bubble = req.kind === 'help' ? (req.urgent ? '!' : '?') : null;
    return {
      legs: [
        { fx: start.lx, fy: start.ly, tx: a.lx, ty: a.ly, dir: travelDir(start.lx, start.ly, a.lx, a.ly), dur: dur(start.lx, start.ly, a.lx, a.ly), carry, bubble: null },
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
        gestures.clear();
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
          const existing = walks.get(name);
          if (existing?.ambient) {
            // A coffee-stroll is in flight: a no-op roster refresh shouldn't yank the walker back
            // mid-stride. Only interrupt it when this member's *home* actually moved (a real reseat),
            // and then send them straight to the new seat from wherever they currently are.
            if (moved(prevHomes.get(name) ?? dest, dest)) {
              walks.set(name, straightWalk(cur.get(name) ?? dest, dest, false));
            }
          } else {
            const from = cur.get(name) ?? prevHomes.get(name)!;
            if (moved(from, dest)) walks.set(name, straightWalk(from, dest, false));
          }
        }
      }
      // Departures (walk out to the door, fading out, then vanish).
      for (const [name, prevHome] of prevHomes) {
        if (newHomes.has(name)) continue;
        const from = cur.get(name) ?? prevHome;
        const node = prevLive.get(name);
        if (node) ghosts.set(name, node);
        pending.delete(name);
        gestures.delete(name); // a departing member stops gesturing
        exiting.add(name);
        walks.set(name, straightWalk(from, entrancePose(from), true, 'out'));
        doorPulses++;
      }
    },
    walk(from, req) {
      if (!homes.has(from) || !homes.has(req.to) || from === req.to || exiting.has(from)) return false;
      const inflight = walks.get(from);
      if (inflight && (inflight.ambient || inflight.yield)) {
        // A real act preempts a low-priority stroll (or its yield-home) *instantly* — it must never queue
        // behind ambient filler (ADR 086: ambient never delays real choreography). Start the real trip
        // from where the avatar currently stands so it doesn't snap back to the seat first.
        const at = posesNow().get(from);
        const w = build(from, req, at);
        pending.delete(from);
        if (w) {
          walks.set(from, w);
          return true;
        }
        walks.delete(from); // target vanished mid-swap — clear the stroll so nothing blocks
      }
      const q = pending.get(from) ?? [];
      if (q.length >= 3) return false; // cap the backlog so a chatty pair doesn't march forever
      q.push(req);
      pending.set(from, q);
      if (!walks.has(from)) startNext(from);
      return true;
    },
    ambientWalk(from) {
      const home = homes.get(from);
      // Only a seated desk member (not nook/queue `small`), present and idle, strolls for coffee.
      if (!home || home.small || exiting.has(from) || walks.has(from) || pending.get(from)?.length) {
        return false;
      }
      const dest = COFFEE_STAND;
      const speed = 68; // logical units/sec — a slow, unhurried amble (cheaper-reading than a real errand)
      const dur = (fx: number, fy: number, tx: number, ty: number): number =>
        clamp(Math.hypot(tx - fx, ty - fy) / speed, 1.8, 5);
      walks.set(from, {
        legs: [
          { fx: home.lx, fy: home.ly, tx: dest.lx, ty: dest.ly, dir: travelDir(home.lx, home.ly, dest.lx, dest.ly), dur: dur(home.lx, home.ly, dest.lx, dest.ly), carry: false, bubble: null },
          { fx: dest.lx, fy: dest.ly, tx: dest.lx, ty: dest.ly, dir: 'N', dur: 1.6, carry: false, bubble: null }, // pause facing the machine
          { fx: dest.lx, fy: dest.ly, tx: home.lx, ty: home.ly, dir: travelDir(dest.lx, dest.ly, home.lx, home.ly), dur: dur(dest.lx, dest.ly, home.lx, home.ly), carry: false, bubble: null },
        ],
        i: 0,
        t: 0,
        small: false,
        ambient: true,
      });
      return true;
    },
    gestureBeat(from, kind) {
      const home = homes.get(from);
      // Only a seated desk member, present and idle (not walking/queued/already gesturing), gestures.
      if (
        !home ||
        home.small ||
        exiting.has(from) ||
        walks.has(from) ||
        pending.get(from)?.length ||
        gestures.has(from)
      ) {
        return false;
      }
      gestures.set(from, { kind, t: 0, dur: 2.4 }); // ~2.4s window — a full stretch/glance loop, then clear
      return true;
    },
    idleDeskMembers() {
      const out: string[] = [];
      for (const [name, pose] of homes) {
        if (pose.small || walks.has(name) || exiting.has(name) || pending.get(name)?.length || gestures.has(name)) {
          continue;
        }
        out.push(name);
      }
      return out;
    },
    ambientOnly() {
      if (walks.size === 0 && gestures.size === 0) return false;
      for (const w of walks.values()) if (!w.ambient) return false;
      return true; // only ambient strolls and/or in-place gestures in flight
    },
    cancelAmbient() {
      const cur = posesNow();
      for (const [name, w] of [...walks]) {
        if (!w.ambient) continue;
        const home = homes.get(name);
        const at = cur.get(name);
        // Yield gracefully: if the walker has left home, walk them straight back (a plain non-ambient
        // walk — full-fps, not itself preemptable); if they're essentially home already, just drop it.
        if (home && at && moved(at, home)) {
          const back = straightWalk(at, home, false);
          back.yield = true; // low-priority: a real act for this member preempts it instantly (see `walk`)
          walks.set(name, back);
        } else {
          walks.delete(name);
        }
      }
      gestures.clear(); // a real act preempts in-place gestures too — they carry no motion to yield home
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
      // Age in-place gestures; drop each when its window elapses (returns the member to a plain idle pose).
      for (const [name, g] of [...gestures.entries()]) {
        g.t += dt;
        if (g.t >= g.dur) gestures.delete(name);
      }
      return walks.size > 0 || gestures.size > 0;
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
      return walks.size > 0 || gestures.size > 0;
    },
  };
}
