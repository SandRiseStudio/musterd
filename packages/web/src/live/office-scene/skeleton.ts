/**
 * The character skeleton — the office's one piece of *animation authoring*, and deliberately the only
 * piece with no renderer in it.
 *
 * `solveSkeleton()` is pure: it takes a member's animation state (gait phase, sit blend, facing, typing…)
 * and returns **joint positions in the character's own 3D space** — x right, y up, z forward, origin at
 * the feet on the floor, in the same logical units as the floor plan (so a joint's `y` composes directly
 * with `DESK_UP`, `SEAT_TOP` and friends).
 *
 * Keeping it 3D and renderer-free is the whole point. `character.ts` happens to flatten these joints onto
 * a 2:1 iso canvas today, but the walk cycle, the sit-down ease and the typing ripple are expressed as
 * joint curves — exactly the data a glTF skeleton consumes. If the office ever moves to a real 3D
 * renderer, the art gets replaced and *this file survives*: bind the same joints to real bones.
 *
 * Two rules the animation leans on, both of which are what make it read as weight rather than as sliding
 * clip art:
 *  - **The gait phase advances with distance travelled, not with wall-clock time** (see `actors.ts`). A
 *    stride is a fixed length of floor, so feet plant instead of skating when a walker speeds up or slows.
 *  - **The legs are solved by IK from a foot path**, not by swinging bones on a sine. The foot follows a
 *    plant-and-lift loop and the knee is whatever angle reaches it — so a foot never sinks through the
 *    floor and the knee bends because the leg is compressed, not because a curve said so.
 */

import { DESK_UP, KEYBOARD_ALONG, SEAT_BACK, SEAT_TOP } from './layout';
import type { CarryKind } from './types';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3): V3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: V3, b: V3): V3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: V3, s: number): V3 => v(a.x * s, a.y * s, a.z * s);
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return v(a.x / l, a.y / l, a.z / l);
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => v(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
/** Smooth 0→1 ease with zero velocity at both ends — the default for every blend in here. */
export const smooth = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * Character proportions, in logical floor units. Deliberately **chibi** (the head is a third of the body)
 * to match the blocky flat-shaded furniture and stay legible at ~40px tall — these are stylised, not
 * anthropometric. Heights are measured up from the feet.
 */
export const CHAR = {
  /** Overall standing height (crown of the head). */
  height: 96,
  ankle: 3,
  knee: 19,
  hip: 36,
  chest: 52,
  shoulder: 58,
  neck: 64,
  /** Head centre; the crown is `headC + headR`. A gentle charm nudge (11.5 → 12.6): a slightly bigger head
   * reads younger and cuter, and the rounder body (see `TORSO_W` in character.ts) now balances it where a
   * bare-bones stick body couldn't. `headC` drops in step so the crown — and so the label anchor — holds
   * the same height. (13 was the old too-big value that swallowed a *thin* body; 12.6 with a round one sits.) */
  headC: 75.9,
  headR: 12.6,
  /** Half-widths at the hips and shoulders. The shoulders must sit **outside** the torso's own half-width
   * (`TORSO_W / 2` in character.ts) or the arms are swallowed by the body and the far one never shows. */
  hipW: 7,
  shoulderW: 14.5,
  thigh: 17,
  shin: 16,
  upperArm: 15,
  foreArm: 14,
} as const;

/** How much floor a single stride covers. The gait phase is distance/STRIDE, so feet plant, never skate. */
export const STRIDE = 46;

/**
 * The gesture-kind registry — every in-place beat a member can play (`SkelInput.gesture`). One named
 * source of truth for the actor system (durations), the scheduler (weights/eligibility) and the solver
 * (overlays); `0` is "no gesture". Seated micro-beats make an idle office read as *inhabited*: nobody
 * sits frozen at a desk for four minutes, they scratch, sip, lean back, swivel.
 */
export const GESTURE = {
  stretch: 1,
  glance: 2,
  scratch: 3,
  chin: 4,
  lean: 5,
  sip: 6,
  swivel: 7,
  roll: 8,
  // Errand beats (played on a walk's hold/sit legs via `Leg.overlay`, not by the gesture scheduler):
  /** Peering into the open fridge, one hand on the door. */
  browse: 9,
  /** Holding the bottle under the cooler tap, leaning in a touch. */
  fill: 10,
  /** Seated with a plate, the free hand cycling plate → mouth. */
  eat: 11,
  /** Working the espresso machine at counter height. */
  pour: 12,
} as const;

/** An arc-shaped envelope over the gesture window: 0 → 1 → 0, zero-velocity at both ends (no pop). */
const arcEnv = (gT: number): number => Math.sin(smooth(gT) * Math.PI);
/** A plateau envelope: ramp in over the first ~18% of the window, hold, ramp out over the last ~18%. */
const holdEnv = (gT: number): number => Math.min(smooth(gT / 0.18), 1, smooth((1 - gT) / 0.18));

/**
 * How far a rolling chair (and its sitter) shifts straight back from the desk through the `roll` beat —
 * 0 at both ends, peaking mid-window. Pure, so the actor system (body offset) and the scene painter
 * (chair pieces) derive the *same* displacement from the same pose instead of drifting apart.
 */
export function chairShift(gesture: number, gestureT: number): number {
  return gesture === GESTURE.roll ? arcEnv(gestureT) * 12 : 0;
}

/**
 * The swivel beat's yaw (radians): a gentle left-right-left oscillation that ends where it began. Added
 * to the sitter's continuous heading by the actor system and to the chair backrest by the painter.
 * (The hands stay near the keys — the whole figure yawing under them is what reads as a chair swivel.)
 */
export function chairYaw(gesture: number, gestureT: number): number {
  return gesture === GESTURE.swivel ? Math.sin(smooth(gestureT) * 3 * Math.PI) * 0.16 : 0;
}

/**
 * True while a seated beat has pulled the hands off the desk into the lap (blend past a threshold) —
 * the painter's cue to skip the arms-over-desk overlay pass, which would otherwise float lap-resting
 * arms on top of the desk slab.
 */
export function handsInLap(gesture: number, gestureT: number): boolean {
  if (gesture === GESTURE.lean) return holdEnv(gestureT) > 0.15;
  if (gesture === GESTURE.roll) return arcEnv(gestureT) > 0.15;
  return false;
}

/** The full pose of one character, as joints in character space (x right, y up, z forward from the feet). */
export interface Skel {
  pelvis: V3;
  chest: V3;
  neck: V3;
  head: V3;
  hip: [V3, V3];
  knee: [V3, V3];
  ankle: [V3, V3];
  shoulder: [V3, V3];
  elbow: [V3, V3];
  wrist: [V3, V3];
  /** Head radius (constant today; here so the painter never reaches into `CHAR`). */
  headR: number;
  /** 0 standing → 1 seated. The painter uses it to fade the chair-occluded lower body. */
  sit: number;
  /** Up-vector tilt of the torso, for orienting the face/visor/hair with the lean. */
  lean: number;
}

export interface SkelInput {
  /** Gait phase in [0,1) — advanced by *distance travelled* (see `STRIDE`), not by time. */
  phase: number;
  /** Blend into the seated pose, 0→1 (raw; eased here). */
  sit: number;
  /** How much of the walk cycle is expressed, 0→1 (raw; eased here) — so a walker settles into a stand. */
  stride: number;
  /** Urgent walk: longer stride, deeper lean, harder arm drive. */
  run: boolean;
  /** Seconds; the clock for everything that breathes on its own (idle sway, typing, gestures). */
  t: number;
  /** Typing intensity 0→1 — hands ripple on the keys. Only meaningful while seated. */
  typing: number;
  /** What's in the hands: the handoff box (both forearms up at the chest), an errand's plate (both
   * hands, held low and flat), bottle or mug (one right hand, in front) — or nothing. */
  carry: CarryKind | null;
  /** Hand up, attentive — the `request_help` hold. */
  help: boolean;
  /** In-place ambient beat: `1` stretch · `2` glance (ADR 086). */
  gesture: number;
  /** Progress through the gesture window, 0→1. */
  gestureT: number;
  /** A per-member constant in [0,1) that de-syncs idle breathing/sway so a room doesn't pulse in unison. */
  seed: number;
}

/**
 * Two-bone IK. Given a root, a target, the two bone lengths, and a hint for which way the joint bends,
 * return the middle joint. The target is pulled in when it is out of reach, so the limb straightens
 * instead of snapping — the knee/elbow always resolves to *something* physical.
 */
function ik2(root: V3, target: V3, a: number, b: number, bendHint: V3): V3 {
  const toT = sub(target, root);
  const d = clamp(len(toT), Math.abs(a - b) + 0.01, a + b - 0.01);
  const u = norm(toT);
  // Component of the bend hint perpendicular to the bone axis — the plane the joint bends in.
  const dot = bendHint.x * u.x + bendHint.y * u.y + bendHint.z * u.z;
  let n = sub(bendHint, mul(u, dot));
  if (len(n) < 1e-4) n = v(0, 0, 1); // hint parallel to the limb — fall back to bending forward
  n = norm(n);
  // Cosine rule for the angle between the bone and the root→target axis.
  const cos = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sin = Math.sqrt(1 - cos * cos);
  return add(root, add(mul(u, a * cos), mul(n, a * sin)));
}

/** A tiny deterministic hash → [0,1), so a member's idle rhythm is stable across frames and reloads. */
export function seedOf(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Typing intensity for a working member: **bursts, not a metronome.** A stable per-member cycle alternates
 * a few seconds of clattering with a pause to think, and each burst ramps in and out so hands settle onto
 * the keys rather than snapping to them. Returns 0 when the member isn't typing at all — which is also what
 * lets the scene rest (a room of pausing members stops redrawing).
 */
export function typingBurst(seed: number, t: number): number {
  const period = 7 + seed * 5; // 7–12s: type a while, think a while
  const on = 2.2 + seed * 1.6; // 2.2–3.8s of actual clatter
  const p = (t + seed * 40) % period;
  if (p > on) return 0;
  // ramp in over 0.35s, out over 0.5s — no hard edges
  return Math.min(1, smooth(p / 0.35), smooth((on - p) / 0.5));
}

/** The rest (standing, arms down) pose — every other pose is authored as a deviation from this. */
function restPose(): Skel {
  const C = CHAR;
  return {
    pelvis: v(0, C.hip, 0),
    chest: v(0, C.chest, 0),
    neck: v(0, C.neck, 0),
    head: v(0, C.headC, 0),
    hip: [v(-C.hipW, C.hip, 0), v(C.hipW, C.hip, 0)],
    knee: [v(-C.hipW, C.knee, 0), v(C.hipW, C.knee, 0)],
    ankle: [v(-C.hipW, C.ankle, 0), v(C.hipW, C.ankle, 0)],
    shoulder: [v(-C.shoulderW, C.shoulder, 0), v(C.shoulderW, C.shoulder, 0)],
    elbow: [v(-C.shoulderW, C.shoulder - C.upperArm, 0), v(C.shoulderW, C.shoulder - C.upperArm, 0)],
    wrist: [
      v(-C.shoulderW, C.shoulder - C.upperArm - C.foreArm, 0),
      v(C.shoulderW, C.shoulder - C.upperArm - C.foreArm, 0),
    ],
    headR: C.headR,
    sit: 0,
    lean: 0,
  };
}

/**
 * Where a seated member's hands go: onto the desk, at the keyboard. Expressed in character space, so it is
 * purely a function of how far the seat sits back from the desk — the painter and the floor plan agree by
 * construction rather than by two hand-tuned constants drifting apart.
 */
export const DESK_REACH = {
  /** Forward from the seat to the keys. Derived, so moving the chair or the keyboard keeps the hands on
   * the keys instead of leaving them grasping at air. */
  z: SEAT_BACK + KEYBOARD_ALONG,
  /** Hand height: the desk surface plus the key deck. */
  y: DESK_UP + 4,
  /** Half the gap between the hands on the keyboard. */
  x: 7,
} as const;

/**
 * Solve one character's joints for this frame.
 *
 * The standing and seated skeletons are solved independently and then **blended**, so sitting down and
 * standing up are a continuous motion (the caller eases `sit`) rather than a state swap — the member folds
 * onto the chair and unfolds off it.
 */
export function solveSkeleton(inp: SkelInput): Skel {
  const sit = smooth(inp.sit);
  const stand = solveStanding(inp);
  if (sit <= 0.001) return stand;
  const seat = solveSeated(inp);
  if (sit >= 0.999) return seat;
  return blend(stand, seat, sit);
}

function blend(a: Skel, b: Skel, t: number): Skel {
  const pair = (p: [V3, V3], q: [V3, V3]): [V3, V3] => [lerp3(p[0], q[0], t), lerp3(p[1], q[1], t)];
  return {
    pelvis: lerp3(a.pelvis, b.pelvis, t),
    chest: lerp3(a.chest, b.chest, t),
    neck: lerp3(a.neck, b.neck, t),
    head: lerp3(a.head, b.head, t),
    hip: pair(a.hip, b.hip),
    knee: pair(a.knee, b.knee),
    ankle: pair(a.ankle, b.ankle),
    shoulder: pair(a.shoulder, b.shoulder),
    elbow: pair(a.elbow, b.elbow),
    wrist: pair(a.wrist, b.wrist),
    headR: a.headR,
    sit: lerp(a.sit, b.sit, t),
    lean: lerp(a.lean, b.lean, t),
  };
}

/** Rotate a point about the pelvis in the sagittal (y,z) plane — the torso's forward lean. */
function leanAbout(p: V3, pivot: V3, ang: number): V3 {
  const dy = p.y - pivot.y;
  const dz = p.z - pivot.z;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return v(p.x, pivot.y + dy * c - dz * s, pivot.z + dy * s + dz * c);
}

// ── standing / walking ────────────────────────────────────────────────────────────────────────────────

function solveStanding(inp: SkelInput): Skel {
  const stride = smooth(inp.stride);
  const idle = solveIdle(inp);
  const s = stride <= 0.001 ? idle : stride >= 0.999 ? solveWalk(inp) : blend(idle, solveWalk(inp), stride);
  applyOverlays(s, inp);
  return s;
}

/** Standing at rest: breathing, a slow weight shift, arms hanging. Never a statue. */
function solveIdle(inp: SkelInput): Skel {
  const C = CHAR;
  const s = restPose();
  // Seeded per member, so a room of idle people doesn't inhale in unison — the single cheapest thing that
  // stops a crowd reading as clones.
  const bt = inp.t * 0.9 + inp.seed * 7;
  const breath = Math.sin(bt) * 0.7;
  const sway = Math.sin(bt * 0.55) * 0.9;

  s.pelvis = v(sway * 0.4, C.hip + breath * 0.25, 0);
  s.chest = v(sway * 0.7, C.chest + breath, 0);
  s.neck = v(sway * 0.8, C.neck + breath, 0);
  s.head = v(sway, C.headC + breath * 0.9, 0);
  for (const i of [0, 1] as const) {
    const sgn = i === 0 ? -1 : 1;
    s.hip[i] = v(sgn * C.hipW + sway * 0.4, C.hip + breath * 0.25, 0);
    s.knee[i] = v(sgn * C.hipW, C.knee, 0.6); // a hair of bend — locked knees read as a mannequin
    s.ankle[i] = v(sgn * C.hipW, C.ankle, 0);
    s.shoulder[i] = v(sgn * C.shoulderW + sway * 0.8, C.shoulder + breath, 0);
    const hang = v(sgn * (C.shoulderW + 1.5), C.shoulder - C.upperArm - C.foreArm + 1, 1.5);
    s.wrist[i] = hang;
    s.elbow[i] = ik2(s.shoulder[i], hang, C.upperArm, C.foreArm, v(sgn * 0.35, 0, -1));
  }
  return s;
}

/**
 * The walk cycle. Amplitudes grow with urgency: a run reaches further, lifts higher, and drives the arms
 * harder. The *rate* is not set here at all — it comes from the phase, which the actor system integrates
 * from distance travelled, so the legs cycle faster because the body is going faster.
 */
function solveWalk(inp: SkelInput): Skel {
  const C = CHAR;
  const s = restPose();
  const th = inp.phase * Math.PI * 2;
  const run = inp.run ? 1 : 0;

  const reach = lerp(11, 16, run); // how far the foot swings fore/aft of the body
  const lift = lerp(6.5, 10, run); // peak foot clearance in mid-swing
  const bob = lerp(1.9, 2.9, run); // vertical rise/fall of the pelvis, twice per stride
  const armSw = lerp(9, 15, run); // fore/aft arm swing at the wrist
  const lean = lerp(0.07, 0.2, run); // torso pitch into the direction of travel

  // Pelvis rises over each single-support (legs together) and dips at double-support — hence 2θ. It also
  // rolls onto the loaded leg, which is what makes a walk read as weighted rather than clocked.
  const pelY = C.hip - bob * 0.5 + bob * 0.5 * Math.cos(2 * th);
  const pelX = Math.sin(th) * lerp(1.4, 2.1, run);
  s.pelvis = v(pelX, pelY, 0);

  for (const i of [0, 1] as const) {
    const sgn = i === 0 ? -1 : 1;
    const lth = i === 0 ? th + Math.PI : th; // the left leg is half a cycle behind the right

    // The foot's path over the ground: it swings forward through the air, then plants and is dragged back
    // under the body. Lifting *only* on the swing half is the whole trick — that is what plants the foot.
    const fz = Math.cos(lth) * reach;
    const fy = C.ankle + Math.max(0, -Math.sin(lth)) * lift;
    const hip = v(sgn * C.hipW + pelX, pelY, 0);
    const foot = v(sgn * C.hipW, fy, fz);
    s.hip[i] = hip;
    s.ankle[i] = foot;
    // The knee is solved *to* the foot, so its bend is a consequence of the leg being compressed. A foot
    // can never punch through the floor to satisfy a curve, which is the failure mode of swinging bones.
    s.knee[i] = ik2(hip, foot, C.thigh, C.shin, v(0, 0, 1));

    // Arms counter-swing against the diagonal leg — the thing whose absence reads instantly as "gliding".
    const ath = lth + Math.PI;
    const sh = v(sgn * C.shoulderW + pelX * 0.5, C.shoulder + (pelY - C.hip), 0);
    const wr = v(
      sgn * (C.shoulderW + 1),
      C.shoulder - C.upperArm - C.foreArm + 3 + Math.abs(Math.cos(ath)) * 2,
      Math.cos(ath) * armSw,
    );
    s.shoulder[i] = sh;
    s.wrist[i] = wr;
    s.elbow[i] = ik2(sh, wr, C.upperArm, C.foreArm, v(sgn * 0.3, 0, -1));
  }

  // The head bobs a little less than the chest, so it reads as carried on a spine rather than welded on.
  s.chest = v(pelX * 0.6, C.chest + (pelY - C.hip) * 0.8, 0);
  s.neck = v(pelX * 0.4, C.neck + (pelY - C.hip) * 0.7, 0);
  s.head = v(pelX * 0.3, C.headC + (pelY - C.hip) * 0.55, 0);
  s.lean = lean;
  for (const k of ['chest', 'neck', 'head'] as const) s[k] = leanAbout(s[k], s.pelvis, lean);
  for (const i of [0, 1] as const) {
    s.shoulder[i] = leanAbout(s.shoulder[i], s.pelvis, lean);
    s.elbow[i] = leanAbout(s.elbow[i], s.pelvis, lean);
    s.wrist[i] = leanAbout(s.wrist[i], s.pelvis, lean);
  }
  return s;
}

// ── seated ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Seated at a desk: pelvis on the chair seat, thighs forward, shins down, spine up with a small forward
 * lean into the screen, and **forearms resting on the desk with the hands on the keys**. The arms are
 * solved by IK to a fixed hand target on the desk, so the elbows land wherever the reach actually puts
 * them — tuck the chair in and the elbows come back on their own.
 */
function solveSeated(inp: SkelInput): Skel {
  const C = CHAR;
  const s = restPose();
  const bt = inp.t * 1.05 + inp.seed * 7;
  const breath = Math.sin(bt) * 0.55;
  // A seated member drifts almost imperceptibly — the weight settles from one hip to the other.
  const settle = Math.sin(bt * 0.4) * 0.6;

  const pelvis = v(settle * 0.3, SEAT_TOP + 1 + breath * 0.15, -1);
  const lean = 0.16; // leaning into the work

  s.pelvis = pelvis;
  s.chest = leanAbout(v(settle * 0.5, pelvis.y + (C.chest - C.hip), pelvis.z), pelvis, lean);
  s.neck = leanAbout(v(settle * 0.6, pelvis.y + (C.neck - C.hip) + breath * 0.5, pelvis.z), pelvis, lean);
  s.head = leanAbout(v(settle * 0.7, pelvis.y + (C.headC - C.hip) + breath * 0.4, pelvis.z), pelvis, lean);
  s.lean = lean;

  for (const i of [0, 1] as const) {
    const sgn = i === 0 ? -1 : 1;
    const hip = v(sgn * C.hipW + settle * 0.3, pelvis.y, pelvis.z);
    s.hip[i] = hip;
    // Thigh forward and very slightly down; shin straight down to a flat foot. The foot target is on the
    // floor, so the same IK that walks the character also folds it onto a chair.
    const foot = v(sgn * (C.hipW + 1.5), C.ankle, pelvis.z + C.thigh + 4);
    s.ankle[i] = foot;
    s.knee[i] = ik2(hip, foot, C.thigh, C.shin, v(0, 1, 0.35)); // knee rides up and forward

    // Hands on the keyboard. Typing is a *ripple*, not a piston: the hands alternate, each finger-tap is a
    // small drop-and-recover, and a per-hand offset keeps them from hammering in lockstep.
    const tap = inp.typing > 0 ? typingTap(inp.t, inp.seed, i) * inp.typing : 0;
    const idleHand = inp.typing > 0 ? 0 : Math.sin(bt * 0.7 + i) * 0.4; // resting hands still breathe
    const hand = v(
      sgn * DESK_REACH.x + settle * 0.4,
      DESK_REACH.y - tap * 1.8 + idleHand,
      DESK_REACH.z + tap * 0.6,
    );
    const sh = leanAbout(
      v(sgn * C.shoulderW + settle * 0.5, pelvis.y + (C.shoulder - C.hip) + breath, pelvis.z),
      pelvis,
      lean,
    );
    s.shoulder[i] = sh;
    s.wrist[i] = hand;
    // Elbows bend down-and-out — the natural desk posture. Without the outward hint the IK would pick a
    // plane that folds the arms into the ribs.
    s.elbow[i] = ik2(sh, hand, C.upperArm, C.foreArm, v(sgn * 0.8, -1, -0.25));
  }

  s.sit = 1;
  applyOverlays(s, inp);
  return s;
}

/** One hand's typing tap: a fast, slightly irregular finger drum, offset per hand so they alternate. */
function typingTap(t: number, seed: number, hand: number): number {
  const rate = 11 + seed * 3; // taps/sec — quick, but not a machine gun
  const p = t * rate + hand * 0.5 + seed * 3;
  const f = p - Math.floor(p);
  // A sharp strike and a softer recover — the asymmetry is what reads as "keys" rather than "bobbing".
  return f < 0.35 ? smooth(f / 0.35) : 1 - smooth((f - 0.35) / 0.65);
}

// ── overlays (carry / help / ambient gestures) ────────────────────────────────────────────────────────

/** Overlays ride on top of whichever base pose was solved, so a carrying walker still walks. */
function applyOverlays(s: Skel, inp: SkelInput): void {
  const C = CHAR;
  if (inp.carry === 'box' || inp.carry === 'plate') {
    // Both hands forward, holding it — at the chest for the box, lower and flatter for a plate of food.
    const y = inp.carry === 'box' ? s.chest.y - 2 : s.chest.y - 9;
    const z = inp.carry === 'box' ? s.chest.z + 13 : s.chest.z + 12;
    const span = inp.carry === 'box' ? 8 : 6.5;
    for (const i of [0, 1] as const) {
      const sgn = i === 0 ? -1 : 1;
      const hand = v(sgn * span, y, z);
      s.wrist[i] = hand;
      s.elbow[i] = ik2(s.shoulder[i], hand, C.upperArm, C.foreArm, v(sgn * 0.9, -0.6, 0));
    }
  } else if (inp.carry === 'bottle' || inp.carry === 'mug') {
    // One-handed: the right hand holds it out in front, low — the walk keeps its counter-swing left arm.
    const hand = v(6, s.chest.y - 10, s.chest.z + 10);
    s.wrist[1] = hand;
    s.elbow[1] = ik2(s.shoulder[1], hand, C.upperArm, C.foreArm, v(0.9, -0.6, 0));
  }
  if (inp.help) {
    // The raised hand — a real reach up and slightly out, with a small wave so it reads as "over here".
    const wave = Math.sin(inp.t * 5.5) * 3;
    const hand = v(C.shoulderW + 6 + wave * 0.4, C.shoulder + C.upperArm + C.foreArm - 4, 2 + wave * 0.3);
    s.wrist[1] = hand;
    s.elbow[1] = ik2(s.shoulder[1], hand, C.upperArm, C.foreArm, v(1, 0, 0.5));
  }
  // Both hands drop off the desk into the lap — the resting posture for the recline/chair beats, where
  // hands left on the keyboard would read as glued there while the whole body moves away from it.
  const lapHands = (a: number): void => {
    for (const i of [0, 1] as const) {
      const sgn = i === 0 ? -1 : 1;
      const lap = v(sgn * (C.hipW + 3), s.pelvis.y + 8, s.pelvis.z + 12);
      s.wrist[i] = lerp3(s.wrist[i], lap, a);
      s.elbow[i] = ik2(s.shoulder[i], s.wrist[i], C.upperArm, C.foreArm, v(sgn * 0.7, -1, 0));
    }
  };
  // Recline the whole upper body about the pelvis (undoing the into-the-work lean and past it).
  const recline = (ang: number): void => {
    for (const k of ['chest', 'neck', 'head'] as const) s[k] = leanAbout(s[k], s.pelvis, -ang);
    for (const i of [0, 1] as const) s.shoulder[i] = leanAbout(s.shoulder[i], s.pelvis, -ang);
    s.lean -= ang;
  };

  if (inp.gesture === GESTURE.stretch) {
    // Stretch: both arms up and back, spine extends, head tips back — one slow arc in and out.
    const a = arcEnv(inp.gestureT);
    for (const i of [0, 1] as const) {
      const sgn = i === 0 ? -1 : 1;
      const top = v(sgn * (C.shoulderW + 4), s.shoulder[i].y + C.upperArm + C.foreArm - 6, -6);
      const up = lerp3(s.wrist[i], top, a);
      s.wrist[i] = up;
      s.elbow[i] = ik2(s.shoulder[i], up, C.upperArm, C.foreArm, v(sgn, 0, 0.3));
    }
    s.head = v(s.head.x, s.head.y + a * 2, s.head.z - a * 3);
    s.chest = v(s.chest.x, s.chest.y + a * 1.5, s.chest.z - a * 1.5);
  } else if (inp.gesture === GESTURE.glance) {
    // Glance: the head turns away from the screen and drifts back. Cheap, and startlingly human.
    const a = arcEnv(inp.gestureT);
    s.head = v(s.head.x + a * 6, s.head.y + a * 0.5, s.head.z + a * 1.5);
    s.neck = v(s.neck.x + a * 2, s.neck.y, s.neck.z);
  } else if (inp.gesture === GESTURE.scratch) {
    // Scratch: right hand up to the side of the head with a quick little rub; the head tips away a touch.
    const a = arcEnv(inp.gestureT);
    const rub = Math.sin(inp.t * 9) * 1.2 * a;
    const spot = v(C.headR * 0.65, s.head.y + 3 + rub, s.head.z + 1);
    s.wrist[1] = lerp3(s.wrist[1], spot, a);
    s.elbow[1] = ik2(s.shoulder[1], s.wrist[1], C.upperArm, C.foreArm, v(1, 0.3, 0));
    s.head = v(s.head.x - a * 2.5, s.head.y, s.head.z);
  } else if (inp.gesture === GESTURE.chin) {
    // Thinking: hand to chin, head dips slightly toward it, and *holds* — a plateau, not an arc.
    const a = holdEnv(inp.gestureT);
    const chin = v(2.5, s.head.y - 9, s.head.z + 8);
    s.wrist[1] = lerp3(s.wrist[1], chin, a);
    s.elbow[1] = ik2(s.shoulder[1], s.wrist[1], C.upperArm, C.foreArm, v(1, -0.4, 0.3));
    s.head = v(s.head.x, s.head.y - a * 1, s.head.z + a * 0.8);
  } else if (inp.gesture === GESTURE.lean) {
    // Lean back: recline past vertical, hands drop to the lap, hold, then fold back into the work.
    const a = holdEnv(inp.gestureT);
    recline(a * 0.28);
    lapHands(a);
  } else if (inp.gesture === GESTURE.sip) {
    // Sip: reach up (the mug travels in the painter's hand), tip it — and the head — back, and return.
    const gt = inp.gestureT;
    const up = gt < 0.28 ? smooth(gt / 0.28) : gt > 0.72 ? 1 - smooth((gt - 0.72) / 0.28) : 1;
    const tip = gt >= 0.28 && gt <= 0.72 ? Math.sin(((gt - 0.28) / 0.44) * Math.PI) : 0;
    const mouth = v(2, s.head.y - 6 + tip * 1.2, s.head.z + C.headR * 0.6 + 2);
    s.wrist[1] = lerp3(s.wrist[1], mouth, up);
    s.elbow[1] = ik2(s.shoulder[1], s.wrist[1], C.upperArm, C.foreArm, v(1, -0.3, 0));
    s.head = v(s.head.x, s.head.y + tip * 0.8, s.head.z - tip * 1.2);
  } else if (inp.gesture === GESTURE.roll) {
    // Roll-back: the chair (and body — `chairShift`) drifts back from the desk; hands in the lap, a
    // hint of recline, then it all rolls home.
    const a = arcEnv(inp.gestureT);
    recline(a * 0.1);
    lapHands(a);
  } else if (inp.gesture === GESTURE.browse) {
    // Browsing the open fridge: one hand up on the door edge, head craned a touch forward and down —
    // the universal "what have we got" stance.
    const a = holdEnv(inp.gestureT);
    const door = v(10, s.chest.y + 6, s.chest.z + 9);
    s.wrist[1] = lerp3(s.wrist[1], door, a);
    s.elbow[1] = ik2(s.shoulder[1], s.wrist[1], C.upperArm, C.foreArm, v(1, 0, 0.4));
    s.head = v(s.head.x, s.head.y - a * 1.2, s.head.z + a * 2);
  } else if (inp.gesture === GESTURE.fill) {
    // Filling at the cooler: the bottle hand drops to the tap and holds there; a slight lean in.
    const a = holdEnv(inp.gestureT);
    const tap = v(2, 26, 13);
    s.wrist[1] = lerp3(s.wrist[1], tap, a);
    s.elbow[1] = ik2(s.shoulder[1], s.wrist[1], C.upperArm, C.foreArm, v(0.8, -0.6, 0.3));
    s.head = v(s.head.x, s.head.y - a * 0.8, s.head.z + a * 1.2);
  } else if (inp.gesture === GESTURE.eat) {
    // Eating: the plate stays in the left hand (carry overlay put both hands under it); the right hand
    // cycles plate → mouth at a relaxed bite rate for as long as the sit-and-eat leg lasts.
    const a = holdEnv(inp.gestureT);
    const bite = (Math.sin(inp.t * 4.6) + 1) / 2; // 0 at the plate → 1 at the mouth, ~0.7 Hz
    const plate = s.wrist[1];
    const mouth = v(2, s.head.y - 6, s.head.z + C.headR * 0.55 + 2);
    s.wrist[1] = lerp3(plate, mouth, a * smooth(bite));
    s.elbow[1] = ik2(s.shoulder[1], s.wrist[1], C.upperArm, C.foreArm, v(1, -0.3, 0));
  } else if (inp.gesture === GESTURE.pour) {
    // Working the machine: right hand forward at counter height, a small press-and-hold.
    const a = holdEnv(inp.gestureT);
    const press = Math.sin(inp.t * 6) * 0.8 * a;
    const head = v(3, 36 + press, 13);
    s.wrist[1] = lerp3(s.wrist[1], head, a);
    s.elbow[1] = ik2(s.shoulder[1], s.wrist[1], C.upperArm, C.foreArm, v(0.9, -0.5, 0.2));
  }
}
