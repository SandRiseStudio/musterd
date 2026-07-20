import {
  COFFEE_STAND,
  COOLER_STAND,
  DESK_SLOTS,
  ENTRANCE,
  FRIDGE_STAND,
  FWD,
  LEISURE_SPOTS,
  NOOK,
  NOOK_CAP,
  NOOK_SPOTS,
  SEAT_BACK,
  SINK_STAND,
  STRIP_CAP,
} from './layout';
import { findPath, type P } from './nav';
import type { Placement } from './seating';
import { chairShift, chairYaw, GESTURE, STRIDE } from './skeleton';
import type { Bubble, CarryKind, Dir, OfficeNode, Pose } from './types';

/** A leisure-spot shape (couch cushion / armchair) an errand can sit at — see `layout.LEISURE_SPOTS`. */
type Spot = (typeof LEISURE_SPOTS)[number];

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
const easeIn = (t: number): number => t * t;
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
/** Velocity profile of one walk leg — see `legsAlong`, which picks these so speed is continuous. */
type Ease = 'in' | 'out' | 'inOut' | 'linear';
const EASE: Record<Ease, (t: number) => number> = { in: easeIn, out: easeOut, inOut: easeInOut, linear: (t) => t };

/** How fast a member swivels to a new facing (radians/sec) — a quarter turn in ~0.17s, brisk but visible. */
const TURN_RATE = 9;
/** A cardinal's facing angle on the logical floor (E=0, S=π/2 — the angles of `layout.FWD`'s vectors). */
const DIR_ANGLE: Record<Dir, number> = { E: 0, S: Math.PI / 2, W: Math.PI, N: -Math.PI / 2 };
/** Shortest signed arc from angle `a` to angle `b`, in (-π, π] — so a turn never goes the long way round. */
function arcTo(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
/** The nearest cardinal to a heading — the legibility reads (billboard face, labels) stay 4-way. */
function dirOfHeading(h: number): Dir {
  const c = Math.cos(h);
  const s = Math.sin(h);
  if (Math.abs(c) >= Math.abs(s)) return c >= 0 ? 'E' : 'W';
  return s >= 0 ? 'S' : 'N';
}

/** How long a member takes to settle out of a stride, and to fold onto (or off) a chair. */
const STRIDE_EASE = 0.18; // seconds
const SIT_EASE = 0.6; // seconds — unhurried; you can see them sit

/** Each gesture beat's window, seconds. Arcs (stretch/scratch/swivel/roll) run their full curve once;
 * plateau beats (chin/lean) hold their pose for most of the window — a think reads longer than a rub. */
const GESTURE_DUR: Record<number, number> = {
  [GESTURE.stretch]: 2.4,
  [GESTURE.glance]: 2.4,
  [GESTURE.scratch]: 2.8,
  [GESTURE.chin]: 4.5,
  [GESTURE.lean]: 4.0,
  [GESTURE.sip]: 3.2,
  [GESTURE.swivel]: 3.5,
  [GESTURE.roll]: 3.0,
};
/** Move `cur` toward `target` at a constant rate (the blend is shaped by `smooth()` where it's consumed). */
function toward(cur: number, target: number, rate: number): number {
  return cur < target ? Math.min(target, cur + rate) : Math.max(target, cur - rate);
}

/** The animation state a member carries *between* frames — none of it is derivable from the pose alone. */
interface Anim {
  /** Gait phase, advanced by distance travelled (see `Pose.phase`). */
  phase: number;
  /** Walk-cycle expression, eased 0↔1. */
  stride: number;
  /** Seated blend, eased 0↔1. */
  sit: number;
  /** Continuous facing (radians, logical space; E=0, S=π/2). Turned at `TURN_RATE` toward the travel
   * direction while walking and back to the home cardinal at rest — a direction change is a swivel,
   * never a snap. The pose's `dir` is quantized from this for the 4-way legibility reads. */
  head: number;
}

/** The animation fields every freshly-built pose starts from; the live values are overlaid in `posesNow`. */
const AT_REST = { moving: false, run: false, gesture: 0, gestureT: 0, phase: 0, stride: 0, sit: 0 } as const;

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
        carry: null,
        bubble: null,
        alpha: 1,
        ...AT_REST,
        sit: 1, // a desk member's home *is* the chair — they belong seated
      });
    } else if (pl.kind === 'leisure') {
      const spot = LEISURE_SPOTS[pl.spot];
      if (!spot) continue;
      // Idle members stay full-size and keep their name label: "who is idle, and where did they go?" is
      // exactly the read this placement exists to give, and a `small` avatar drops its label.
      out.set(name, {
        lx: spot.lx,
        ly: spot.ly,
        dir: spot.dir,
        small: false,
        carry: null,
        bubble: null,
        alpha: 1,
        ...AT_REST,
        sit: spot.sit,
      });
    } else if (pl.kind === 'nook') {
      const i = nook.indexOf(name);
      if (i >= NOOK_CAP) continue; // past the cap: represented by the "+N away" pill, not an avatar
      // The away cluster stands in a loose arc on the rug around the lounge set's open side —
      // hand-placed spots (layout.NOOK_SPOTS) so nobody stands inside the couch/armchairs/table.
      const spot = NOOK_SPOTS[i]!;
      out.set(name, {
        lx: NOOK.lx + spot.dx,
        ly: NOOK.ly + spot.dy,
        dir: 'S',
        small: true,
        carry: null,
        bubble: null,
        alpha: 1,
        ...AT_REST,
      });
    } else if (pl.kind === 'strip') {
      if (pl.index >= STRIP_CAP) continue; // past the cap: represented by the "+N waiting" pill
      // Overflow past the 12 desks: a single-file queue receding from the entrance into the room, facing
      // the desks — reads as "waiting to be seated" rather than a floating grid stacked off the edge.
      // The door is on the back-left wall, so the line recedes inward (+lx) toward the desks.
      out.set(name, {
        lx: ENTRANCE.lx + 34 + pl.index * 32,
        ly: ENTRANCE.ly - 10 - pl.index * 6,
        dir: 'N',
        small: true,
        carry: null,
        bubble: null,
        alpha: 1,
        ...AT_REST,
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
  carry: CarryKind | null;
  bubble: Bubble;
  /** Velocity profile across this leg. A routed run is shaped `in` → `linear`… → `out` so speed is
   * continuous through every waypoint (see `legsAlong`); a stationary hold leg's ease is irrelevant. */
  ease: Ease;
  /** A gesture overlay played across this leg (`GESTURE.browse/fill/eat/pour…`) — `gestureT` runs the
   * leg's own 0→1 clock, so a dwell's beat spans exactly its dwell. */
  overlay?: number;
  /** Sit on furniture through this leg (an errand's couch/armchair meal): the sit blend eases to 1 and
   * the pose composite-sorts at `sitAt.depthAt` where the spot needs it. */
  sitAt?: Spot;
  /** The fridge door stands open through this leg (derived per-frame by `sceneFx` — never stored). */
  door?: boolean;
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

/** How fast an errand ambles — slower than an act-walk; nobody hurries to the fridge. */
const ERRAND_SPEED = 68;

/** Where a run of travel legs actually ends (the routed endpoint may differ from the asked-for point). */
function endOf(legs: Leg[]): P {
  const last = legs[legs.length - 1]!;
  return { lx: last.tx, ly: last.ty };
}

/** A stationary dwell leg: stand at `at` facing `dir` for `dur`, with an errand's own flags riding it. */
function hold(
  at: P,
  dir: Dir,
  dur: number,
  extra: { carry?: CarryKind; overlay?: number; door?: boolean },
): Leg {
  return {
    fx: at.lx,
    fy: at.ly,
    tx: at.lx,
    ty: at.ly,
    dir,
    dur,
    carry: extra.carry ?? null,
    bubble: null,
    ease: 'inOut',
    ...(extra.overlay !== undefined ? { overlay: extra.overlay } : {}),
    ...(extra.door !== undefined ? { door: extra.door } : {}),
  };
}

/** A point ~offset in front of `target`, on the side facing `mover` — where a visitor stands. */
function approach(target: { lx: number; ly: number }, mover: { lx: number; ly: number }): { lx: number; ly: number } {
  const dx = mover.lx - target.lx;
  const dy = mover.ly - target.ly;
  const d = Math.hypot(dx, dy) || 1;
  const off = clamp(d * 0.4, 46, 72);
  return { lx: target.lx + (dx / d) * off, ly: target.ly + (dy / d) * off };
}

/**
 * Travel legs along a routed polyline, shaped so the walk is **one continuous motion**: cruise speed
 * `v` = pathLength / clamp(pathLength/speed), interior legs run `linear` at exactly `v`, and the end
 * legs run quadratic `in`/`out` at double duration — a quadratic's boundary slope is 2, so the eased
 * leg meets the cruise legs at exactly `v` and position is C¹-continuous through every waypoint. The
 * old shape (easeInOut per leg) braked to a dead stop at each string-pulled corner, which read as
 * "walk a few steps, pause, turn, walk again".
 */
function legsAlong(pts: P[], speed: number, minDur: number, maxDur: number, carry: CarryKind | null): Leg[] {
  const segs: Array<{ a: P; b: P; len: number }> = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.lx - a.lx, b.ly - a.ly);
    if (len < 1) continue;
    segs.push({ a, b, len });
    total += len;
  }
  if (segs.length === 0) {
    const a = pts[0]!;
    return [{ fx: a.lx, fy: a.ly, tx: a.lx, ty: a.ly, dir: 'S', dur: 0.1, carry, bubble: null, ease: 'inOut' }];
  }
  const dur = clamp(total / speed, minDur, maxDur);
  if (segs.length === 1) {
    const { a, b } = segs[0]!;
    return [{ fx: a.lx, fy: a.ly, tx: b.lx, ty: b.ly, dir: travelDir(a.lx, a.ly, b.lx, b.ly), dur, carry, bubble: null, ease: 'inOut' }];
  }
  const v = total / dur; // cruise speed the whole run holds through its waypoints
  const last = segs.length - 1;
  return segs.map(({ a, b, len }, i) => ({
    fx: a.lx,
    fy: a.ly,
    tx: b.lx,
    ty: b.ly,
    dir: travelDir(a.lx, a.ly, b.lx, b.ly),
    dur: Math.max(0.08, ((i === 0 || i === last ? 2 : 1) * len) / v),
    carry,
    bubble: null,
    ease: i === 0 ? ('in' as const) : i === last ? ('out' as const) : ('linear' as const),
  }));
}

export interface Actors {
  /** Reconcile to a new roster: seat everyone, and (when `animate`) walk arrivals in, departures out,
   * and away/return drifts between desk and nook. The first call just snaps (no entrance stampede). */
  setHomes(placements: Map<string, Placement>, byName: Map<string, OfficeNode>, animate: boolean): void;
  /** Enqueue a walk to a teammate. Returns false if it can't play (mover or target not present). */
  walk(from: string, req: Req): boolean;
  /** Enqueue an ambient coffee run for a seated desk member (home → machine → pour → drink → home).
   * Self-generated filler, not a real act; returns false if the member can't stroll (absent, in the
   * nook/queue, exiting, or already busy). See ADR 086 Phase 2. */
  ambientWalk(from: string): boolean;
  /** The water-bottle errand: grab the desk bottle, fill it at the cooler (~5s), bring it back. Same
   * eligibility and preemption contract as `ambientWalk`. */
  errandWater(from: string): boolean;
  /** The fridge-meal errand: open the fridge, browse, carry a plate to a free lounge seat, eat, drop
   * the empty plate at the counter sink, return. False when ineligible or the lounge is full. */
  errandFridge(from: string): boolean;
  /** Scene effects derived from the walks' *current* legs (never stored): whether the fridge door
   * stands open, and whose desk water bottle is in their hand (so the desk copy hides). */
  sceneFx(): { fridgeOpen: boolean; bottleCarriers: Set<string> };
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
  /** Advance all walks + animation blends by dt seconds; true while any walk, gesture, or blend is live. */
  step(dt: number): boolean;
  /** True while a member is mid-blend (settling out of a stride, sitting down, standing up) — the loop
   * must keep running through it or they freeze half-out of the chair. */
  settling(): boolean;
  /** The current pose of every drawn member (home, or interpolated if walking — incl. those leaving). */
  poses(): Map<string, Pose>;
  /** Nodes to draw this frame — the live roster plus any members currently walking out. */
  nodes(): Map<string, OfficeNode>;
  /** How many members entered or left since the last call (clears) — drives the door-open glow. */
  takeDoorPulses(): number;
  /** How many members *arrived* since the last call (clears) — departures don't count. The office dog
   * greets an arrival at the door; nobody, dog included, gets up to see you leave. */
  takeArrivals(): number;
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
  /** Per-member animation blends (gait phase, stride, sit) — carried between frames; see `advanceAnim`. */
  const anim = new Map<string, Anim>();
  const exiting = new Set<string>();
  let initialized = false;
  let doorPulses = 0; // members that entered/left since the last takeDoorPulses()
  let arrivals = 0; // members that entered since the last takeArrivals() — the dog's cue to go and greet

  function entrancePose(ref: Pose): Pose {
    return { lx: ENTRANCE.lx, ly: ENTRANCE.ly, dir: 'N', small: ref.small, carry: null, bubble: null, alpha: 1, ...AT_REST };
  }
  function moved(a: Pose, b: Pose): boolean {
    return Math.hypot(a.lx - b.lx, a.ly - b.ly) > 8;
  }
  /** Everyone else's current standing spot — walkers route around them, not through them. */
  function othersAt(except: string): P[] {
    const out: P[] = [];
    for (const [name, p] of posesNow()) if (name !== except) out.push({ lx: p.lx, ly: p.ly });
    return out;
  }

  /** A routed point-to-point walk (entrance-in, drift, or leave), optionally fading at the door. */
  function straightWalk(who: string, from: Pose, to: Pose, exit: boolean, fade?: 'in' | 'out'): Walk {
    const speed = 78; // logical units/sec — an unhurried stroll across the floor
    const path = findPath({ lx: from.lx, ly: from.ly }, { lx: to.lx, ly: to.ly }, othersAt(who));
    return {
      legs: legsAlong(path, speed, 1.8, 6, null),
      i: 0,
      t: 0,
      small: exit ? from.small : to.small,
      ...(fade ? { fade } : {}),
    };
  }

  /** The between-frame animation state of a member, seeded from their home the first time we see them
   * (or, for a member first seen mid-walk — an arrival — from the walk's own direction of travel). */
  function animOf(name: string): Anim {
    let a = anim.get(name);
    if (!a) {
      const w = walks.get(name);
      const leg = w?.legs[w.i];
      const head =
        leg && (leg.fx !== leg.tx || leg.fy !== leg.ty)
          ? Math.atan2(leg.ty - leg.fy, leg.tx - leg.fx)
          : DIR_ANGLE[leg?.dir ?? homes.get(name)?.dir ?? 'S'];
      a = { phase: 0, stride: 0, sit: homes.get(name)?.sit ?? 0, head };
      anim.set(name, a);
    }
    return a;
  }

  /** The angle this member is turning toward right now: the direction of travel mid-leg, the leg's
   * stated facing on a stationary hold, or the home cardinal at rest. */
  function headingTarget(name: string): number | null {
    const w = walks.get(name);
    const leg = w?.legs[w.i];
    if (leg) {
      if (leg.fx !== leg.tx || leg.fy !== leg.ty) return Math.atan2(leg.ty - leg.fy, leg.tx - leg.fx);
      return DIR_ANGLE[leg.dir];
    }
    const home = homes.get(name);
    return home ? DIR_ANGLE[home.dir] : null;
  }

  function posesNow(): Map<string, Pose> {
    const out = new Map<string, Pose>();
    // At-home members carry any active in-place gesture (a stationary ambient beat overlaid on idle).
    for (const [n, p] of homes) {
      const g = gestures.get(n);
      const a = animOf(n);
      const gT = g ? clamp(g.t / g.dur, 0, 1) : 0;
      // The chair beats move the member *with* the chair: swivel yaws the whole seated figure about the
      // seat; roll-back slides body + chair straight back from the desk and home again. The painter
      // derives the chair pieces' own motion from the same pure curves (`chairYaw`/`chairShift`).
      const yaw = g ? chairYaw(g.kind, gT) : 0;
      const shift = g ? chairShift(g.kind, gT) : 0;
      const f = FWD[p.dir];
      out.set(n, {
        ...p,
        lx: p.lx - f[0] * shift,
        ly: p.ly - f[1] * shift,
        gesture: g?.kind ?? p.gesture,
        gestureT: gT,
        phase: a.phase,
        stride: a.stride,
        sit: a.sit,
        heading: a.head + yaw, // still swivelling into the seat facing after a walk ends
      });
    }
    for (const [name, w] of walks) {
      const leg = w.legs[w.i]!;
      const a = animOf(name);
      const e = EASE[leg.ease](clamp(w.t, 0, 1));
      // Door fade: emerge over the first third entering, dissolve over the last third leaving. Progress
      // is distance covered / total path length — the eased end legs run longer than their share of
      // ground, so leg-index progress would distort the ramp (and it must never restart mid-trip).
      let alpha = 1;
      if (w.fade) {
        let total = 0;
        let done = 0;
        for (let li = 0; li < w.legs.length; li++) {
          const l = w.legs[li]!;
          const len = Math.hypot(l.tx - l.fx, l.ty - l.fy);
          total += len;
          if (li < w.i) done += len;
          else if (li === w.i) done += len * e;
        }
        const prog = total > 0 ? done / total : (w.i + clamp(w.t, 0, 1)) / w.legs.length;
        alpha = w.fade === 'in' ? clamp(prog / 0.35, 0, 1) : clamp((1 - prog) / 0.35, 0, 1);
      }
      out.set(name, {
        lx: leg.fx + (leg.tx - leg.fx) * e,
        ly: leg.fy + (leg.ty - leg.fy) * e,
        dir: dirOfHeading(a.head), // the 4-way legibility read follows the swivel, flipping at 45°
        small: w.small,
        carry: leg.carry,
        bubble: leg.bubble,
        alpha,
        // Travelling (not the hold leg) → `walking`; urgent walks → `run`.
        moving: leg.fx !== leg.tx || leg.fy !== leg.ty,
        run: w.run ?? false,
        // A leg can carry its own beat (an errand's browse/fill/eat/pour dwell), clocked by the leg —
        // plain travel legs stay gesture-free, as before.
        gesture: leg.overlay ?? 0,
        gestureT: leg.overlay ? clamp(w.t, 0, 1) : 0,
        phase: a.phase,
        stride: a.stride,
        sit: a.sit, // eased through stands and errand sits alike (see `sitTargetOf`)
        heading: a.head,
        // An errand sitter on the couch composite-sorts with it, exactly like a leisure placement.
        ...(leg.sitAt?.depthAt ? { depthAt: leg.sitAt.depthAt } : {}),
      });
    }
    return out;
  }

  /**
   * Advance the per-member animation blends from what actually happened on the floor this frame.
   *
   * The gait phase is integrated from **distance travelled** — a stride is `STRIDE` units of floor, so a
   * walker's feet plant on the ground they cover, at any speed, and an urgent run's legs cycle faster
   * because the body is *going* faster, not because a timer was told to hurry.
   */
  function advanceAnim(dt: number, before: Map<string, Pose>, after: Map<string, Pose>): void {
    for (const [name, p] of after) {
      const a = animOf(name);
      const b = before.get(name);
      const dist = b ? Math.hypot(p.lx - b.lx, p.ly - b.ly) : 0;
      a.phase = (a.phase + dist / STRIDE) % 1;
      // Express the walk cycle only while actually covering ground — a walker paused on a hold leg stands.
      const speed = dt > 0 ? dist / dt : 0;
      a.stride = toward(a.stride, p.moving && speed > 2 ? 1 : 0, dt / STRIDE_EASE);
      // Sit whenever the member is home at a seat and not walking — or parked on an errand's sit leg
      // (the couch meal). Rising and settling back are just this blend running in each direction.
      a.sit = toward(a.sit, sitTargetOf(name), dt / SIT_EASE);
      // Swivel the continuous facing toward wherever this member should be looking, shortest way round.
      const want = headingTarget(name);
      if (want !== null) {
        a.head += clamp(arcTo(a.head, want), -TURN_RATE * dt, TURN_RATE * dt);
        if (a.head > Math.PI) a.head -= Math.PI * 2;
        else if (a.head < -Math.PI) a.head += Math.PI * 2;
      }
    }
    for (const n of [...anim.keys()]) if (!after.has(n)) anim.delete(n);
  }

  /** True while any member is still mid-blend (settling out of a stride, sitting down, standing up). The
   * loop must keep running through it, or a member freezes half-out of their chair. */
  /** The shared errand entry guard: only a seated desk member (not nook/queue `small`), present and
   * idle, runs one. Returns their home + the standing crowd to route around, or null. */
  function errandStart(from: string): { home: Pose; avoid: P[] } | null {
    const home = homes.get(from);
    if (!home || home.small || exiting.has(from) || walks.has(from) || pending.get(from)?.length) {
      return null;
    }
    return { home, avoid: othersAt(from) };
  }

  /** A free lounge seat (couch cushion / armchair) for an errand meal: not a member's home, and not
   * already the target of another in-flight errand's sit leg. Null when the lounge is full. */
  function freeLoungeSpot(): Spot | null {
    const open = LEISURE_SPOTS.filter((s) => {
      if (s.zone !== 'lounge') return false;
      for (const h of homes.values()) {
        if (Math.hypot(h.lx - s.lx, h.ly - s.ly) < 20) return false;
      }
      for (const w of walks.values()) {
        for (const leg of w.legs) {
          if (leg.sitAt && Math.hypot(leg.sitAt.lx - s.lx, leg.sitAt.ly - s.ly) < 20) return false;
        }
      }
      return true;
    });
    return open.length ? open[Math.floor(Math.random() * open.length)]! : null;
  }

  /** Where the sit blend is heading for this member: 1 seated (home seat, or an errand's sit leg). */
  function sitTargetOf(name: string): number {
    const w = walks.get(name);
    if (w) return w.legs[w.i]?.sitAt ? 1 : 0;
    return (homes.get(name)?.sit ?? 0) > 0 ? 1 : 0;
  }

  function settling(): boolean {
    for (const [name, a] of anim) {
      if (a.stride > 0.001) return true;
      if (Math.abs(a.sit - sitTargetOf(name)) > 0.001) return true;
      // Mid-turn counts too — parking the loop here would bake a frame of someone facing sideways.
      const want = headingTarget(name);
      if (want !== null && Math.abs(arcTo(a.head, want)) > 0.02) return true;
    }
    return false;
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
    const carry: CarryKind | null = req.kind === 'handoff' ? 'box' : null;
    const hold = req.kind === 'help' ? (req.urgent ? 0.5 : 0.75) : 0.6;
    const holdBubble: Bubble = req.kind === 'help' ? (req.urgent ? '!' : '?') : null;
    // Route both trips around furniture and standing teammates; the visitor's stand spot is wherever
    // the outbound route actually ends (the approach point may get nudged off a blocked cell).
    const avoid = othersAt(from);
    const out = legsAlong(findPath({ lx: start.lx, ly: start.ly }, a, avoid), speed, 1.4, 4.5, carry);
    const stand = { lx: out[out.length - 1]!.tx, ly: out[out.length - 1]!.ty };
    const back = legsAlong(findPath(stand, { lx: home.lx, ly: home.ly }, avoid), speed, 1.4, 4.5, null);
    return {
      legs: [
        ...out,
        { fx: stand.lx, fy: stand.ly, tx: stand.lx, ty: stand.ly, dir: travelDir(stand.lx, stand.ly, target.lx, target.ly), dur: hold, carry, bubble: holdBubble, ease: 'inOut' },
        ...back,
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
        anim.clear(); // snap: everyone starts settled at their home (desk members already seated)
        return;
      }

      // Arrivals (walk in from the door, fading in) and drifts (desk ⇄ nook / reseat).
      for (const [name, dest] of newHomes) {
        if (!prevHomes.has(name)) {
          exiting.delete(name);
          ghosts.delete(name);
          walks.set(name, straightWalk(name, entrancePose(dest), dest, false, 'in'));
          doorPulses++;
          arrivals++;
        } else if (!exiting.has(name)) {
          const existing = walks.get(name);
          if (existing?.ambient) {
            // A coffee-stroll is in flight: a no-op roster refresh shouldn't yank the walker back
            // mid-stride. Only interrupt it when this member's *home* actually moved (a real reseat),
            // and then send them straight to the new seat from wherever they currently are.
            if (moved(prevHomes.get(name) ?? dest, dest)) {
              walks.set(name, straightWalk(name, cur.get(name) ?? dest, dest, false));
            }
          } else {
            const from = cur.get(name) ?? prevHomes.get(name)!;
            if (moved(from, dest)) walks.set(name, straightWalk(name, from, dest, false));
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
        walks.set(name, straightWalk(name, from, entrancePose(from), true, 'out'));
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
      const trip = errandStart(from);
      if (!trip) return false;
      const { home, avoid } = trip;
      // The coffee run, made to *mean* something (it used to stand at the machine doing nothing): work
      // the machine, then actually drink the cup before heading back.
      const out = legsAlong(findPath({ lx: home.lx, ly: home.ly }, COFFEE_STAND, avoid), ERRAND_SPEED, 1.8, 5, null);
      const stand = endOf(out);
      const back = legsAlong(findPath(stand, { lx: home.lx, ly: home.ly }, avoid), ERRAND_SPEED, 1.8, 5, null);
      walks.set(from, {
        legs: [
          ...out,
          hold(stand, 'N', 1.0, { overlay: GESTURE.pour }),
          hold(stand, 'N', 3.0, { carry: 'mug', overlay: GESTURE.sip }),
          hold(stand, 'N', 0.35, {}), // mug set back down by the machine
          ...back,
        ],
        i: 0,
        t: 0,
        small: false,
        ambient: true,
      });
      return true;
    },
    errandWater(from) {
      const trip = errandStart(from);
      if (!trip) return false;
      const { home, avoid } = trip;
      // Grab the bottle off the desk (the desk copy hides while it's in hand — `sceneFx`), amble to the
      // cooler, fill for a good few seconds, come back, put it down.
      const out = legsAlong(findPath({ lx: home.lx, ly: home.ly }, COOLER_STAND, avoid), ERRAND_SPEED, 1.8, 5, 'bottle');
      const stand = endOf(out);
      const back = legsAlong(findPath(stand, { lx: home.lx, ly: home.ly }, avoid), ERRAND_SPEED, 1.8, 5, 'bottle');
      walks.set(from, {
        legs: [
          hold(home, home.dir, 0.45, { carry: 'bottle' }), // pick it up
          ...out,
          hold(stand, 'N', 5.0, { carry: 'bottle', overlay: GESTURE.fill }),
          ...back,
          hold(home, home.dir, 0.4, { carry: 'bottle' }), // set it back down
        ],
        i: 0,
        t: 0,
        small: false,
        ambient: true,
      });
      return true;
    },
    errandFridge(from) {
      const trip = errandStart(from);
      if (!trip) return false;
      const { home, avoid } = trip;
      const spot = freeLoungeSpot();
      if (!spot) return false; // every lounge seat taken — the scheduler picks another beat
      // The full meal arc: open the fridge, browse, take a plate to the lounge, eat, leave the empty
      // plate at the counter sink, come home. Every scene effect (open door, the plate) is derived from
      // the *current* leg, so preemption at any step tidies up by construction.
      const out = legsAlong(findPath({ lx: home.lx, ly: home.ly }, FRIDGE_STAND, avoid), ERRAND_SPEED, 1.8, 5, null);
      const atFridge = endOf(out);
      const toSeat = legsAlong(findPath(atFridge, spot, avoid), ERRAND_SPEED, 1.8, 5, 'plate');
      const atSeat = endOf(toSeat);
      const toSink = legsAlong(findPath(atSeat, SINK_STAND, avoid), ERRAND_SPEED, 1.8, 5, 'plate');
      const atSink = endOf(toSink);
      const back = legsAlong(findPath(atSink, { lx: home.lx, ly: home.ly }, avoid), ERRAND_SPEED, 1.8, 5, null);
      walks.set(from, {
        legs: [
          ...out,
          hold(atFridge, 'N', 0.5, { door: true }), // the door swings open
          hold(atFridge, 'N', 2.2, { door: true, overlay: GESTURE.browse }),
          hold(atFridge, 'N', 0.45, { door: true, carry: 'plate' }), // found something
          ...toSeat,
          { fx: spot.lx, fy: spot.ly, tx: spot.lx, ty: spot.ly, dir: spot.dir, dur: 6.5, carry: 'plate', bubble: null, ease: 'inOut', overlay: GESTURE.eat, sitAt: spot },
          ...toSink,
          hold(atSink, 'N', 0.5, {}), // the empty plate goes in the sink
          ...back,
        ],
        i: 0,
        t: 0,
        small: false,
        ambient: true,
      });
      return true;
    },
    sceneFx() {
      // Derived fresh from the *current* legs every frame, never stored — so a preempted errand's door
      // closes and its props return the instant `cancelAmbient` swaps the walk for a plain trip home.
      let fridgeOpen = false;
      const bottleCarriers = new Set<string>();
      for (const [name, w] of walks) {
        const leg = w.legs[w.i];
        if (!leg) continue;
        if (leg.door) fridgeOpen = true;
        if (leg.carry === 'bottle') bottleCarriers.add(name);
      }
      return { fridgeOpen, bottleCarriers };
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
      gestures.set(from, { kind, t: 0, dur: GESTURE_DUR[kind] ?? 2.4 }); // one full beat window, then clear
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
          const back = straightWalk(name, at, home, false);
          back.yield = true; // low-priority: a real act for this member preempts it instantly (see `walk`)
          walks.set(name, back);
        } else {
          walks.delete(name);
        }
      }
      gestures.clear(); // a real act preempts in-place gestures too — they carry no motion to yield home
    },
    step(dt) {
      const before = posesNow();
      for (const [name, w] of [...walks.entries()]) {
        // Spend the whole frame, carrying the remainder across leg boundaries — discarding it at a
        // boundary (the old `t += dt/dur; if (t>=1) t=0`) froze the walker for up to a frame at every
        // waypoint, a visible hitch on top of any easing.
        let rem = dt;
        let done = false;
        while (rem > 0 && !done) {
          const leg = w.legs[w.i]!;
          const left = (1 - w.t) * leg.dur;
          if (rem < left) {
            w.t += rem / leg.dur;
            rem = 0;
          } else {
            rem -= left;
            w.t = 0;
            w.i++;
            if (w.i >= w.legs.length) done = true;
          }
        }
        if (done) {
          walks.delete(name);
          if (exiting.has(name)) {
            exiting.delete(name);
            ghosts.delete(name);
          } else {
            startNext(name);
          }
        }
      }
      // Age in-place gestures; drop each when its window elapses (returns the member to a plain idle pose).
      for (const [name, g] of [...gestures.entries()]) {
        g.t += dt;
        if (g.t >= g.dur) gestures.delete(name);
      }
      advanceAnim(dt, before, posesNow());
      return walks.size > 0 || gestures.size > 0 || settling();
    },
    poses: posesNow,
    settling,
    nodes() {
      const out = new Map<string, OfficeNode>(ghosts);
      for (const [n, node] of live) out.set(n, node);
      return out;
    },
    takeArrivals() {
      const n = arrivals;
      arrivals = 0;
      return n;
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
