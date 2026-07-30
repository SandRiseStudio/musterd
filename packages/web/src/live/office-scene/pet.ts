import { FLOOR, KX, KY } from './iso';
import {
  BEAM_LEN,
  BEAM_SHEAR,
  DESK_D,
  DESK_SLOTS,
  DESK_W,
  ENTRANCE,
  HUDDLES,
  MEETING,
  NOOK,
  PODS,
  RECEPTION,
  WINDOWS,
} from './layout';
import { findPath, walkable, type P } from './nav';

/**
 * The office dog — behaviour + pose state only, no renderer (the painter lives in render.ts, the same
 * hard line skeleton.ts/character.ts keep). One resident creature that makes the room read as *inhabited*
 * rather than merely furnished: it sleeps curled in the window sunbeams by day and on the rugs by night,
 * and every so often (on the office's existing ambient-beat cadence) it wakes, stretches, pads across the
 * room on the real nav grid, sometimes sits a while beside whoever is working, and curls back up.
 *
 * The species lives in the painter, not here: this file is a plain settle/rove machine, which is why it is
 * `pet.ts` and not `dog.ts` — the office kept a cat before it kept a dog, and the swap was a paint job.
 *
 * The pet is deliberately shaped around the office's rest model (ADR 086): a *sleeping* pet is a static
 * pose, so the baked still frame holds it for free; the pet only asks for animation frames while it is
 * actually stretching/walking/sitting — `stepPet` returns whether it still needs the loop. Gait phase
 * advances from DISTANCE travelled, never wall time (the same no-skate rule the members follow).
 */

export type PetMode = 'sleep' | 'stretch' | 'walk' | 'sit' | 'curl';

export interface PetState {
  lx: number;
  ly: number;
  mode: PetMode;
  /** Seconds spent in the current mode. */
  modeT: number;
  /** Gait phase (cycles), advanced by distance travelled while walking. */
  phase: number;
  /** Screen-space facing INTENT: true = the pet wants to point left. Set the instant the heading
   *  decides; what actually gets drawn is `face`, which chases this. */
  flip: boolean;
  /**
   * The facing the painter draws: the mirror factor, +1 (right) through 0 (edge-on) to −1 (left),
   * eased toward `flip` rather than snapped to it. Passing through 0 IS the turn — the dog narrows,
   * swings through square-on and opens out the other way, which is what a body does when it changes
   * direction. Snapping the mirror was the old behaviour, and a dog that teleports through its own
   * reflection is the single most artificial thing a walk cycle can do.
   */
  face: number;
  /**
   * How side-on the current heading is, 0…1 — the *magnitude* `face` chases, with `flip` supplying
   * the sign.
   *
   * The dog is a profile billboard on a 2:1 iso, so it only ever has a left and a right view. Walking
   * a diagonal it is therefore drawn fully side-on while actually travelling toward or away from the
   * camera, and a full-profile dog moving down the screen reads as a crab (nick, 2026-07-28: "it
   * looks like hes walking sideways"). The bug was always there; giving the dog a real stride is what
   * made it visible.
   *
   * The fix is the foreshortening the turn already had: narrow the whole figure by how much of the
   * heading is actually across the screen. Straight along a wall → full profile. Straight at the
   * camera → as narrow as `MIN_FACE` allows, which reads as a dog coming at you rather than one
   * sliding. Floored well above zero because a true rear view is a pose this painter does not have,
   * and a sliver held for a whole diagonal walk would read as a rendering fault, not a dog.
   */
  faceMag: number;
  /**
   * Which way the depth-wise part of the heading points: +1 walking down-screen (toward the camera),
   * −1 up-screen (away). Only meaningful while `faceMag` is low — it is what lets the painter draw a
   * *face* or a *rump* on the narrow figure instead of holding the profile sliver (the "piece of
   * paper" read, nick 2026-07-29). Sticky: it keeps its last decisive value through the ambiguous
   * moments, so the toward/away view never flutters mid-diagonal.
   */
  depthSign: 1 | -1;
  /**
   * Ground speed right now, logical units/s — eased toward `speed`, not set to it. A dog does not
   * leave a nap at trotting pace or arrive at one still trotting: it winds up out of the stretch and
   * winds down into the last stride. Gait phase advances from THIS, so the legs turn over slower
   * through the ramp for free.
   */
  vel: number;
  /** Current route (waypoints, ends exact) and the segment index into it. */
  path: P[];
  seg: number;
  /** What to do on arrival: settle straight down, or sit a while first. */
  plan: 'nap' | 'sit-then-nap';
  /** How long the arrival sit lasts (seconds), when the plan includes one. */
  sitFor: number;
  /**
   * Travel speed for the current trip, logical units/s. A field rather than a constant so a lap of
   * zoomies can be a *fast* version of the walk it already knows, instead of a second gait to write
   * and keep in sync. The painter reads gait phase from distance travelled, so a higher speed turns
   * the legs over faster for free.
   */
  speed: number;
}

/** Walking speed, logical units/s — an unhurried pad, slower than the members. */
export const PET_SPEED = 55;
/** Zoomies pace. Fast enough to read as a tear around the room, not so fast it teleports. */
export const PET_DASH = 165;
/**
 * One full gait cycle per this much ground covered.
 *
 * **This number and the painter's foot reach are one measurement, not two.** A paw is planted for
 * most of its cycle, so over one cycle it must travel backward under the dog by exactly the ground
 * the dog covers — otherwise the feet scrub, which is the "his feet are barely moving" read. The
 * painter derives its reach from this constant (see `GAIT_REACH` in render.ts) rather than carrying
 * its own hand-tuned swing, so the two cannot drift apart the next time the dog is resized.
 */
export const STRIDE = 19;
/** How hard the dog gets up to speed / sheds it, logical units/s². */
const ACCEL = 190;
/** Inside this much of the destination it is already slowing down for the arrival. */
const BRAKE_D = 46;
/** Never creep below this while still walking — an asymptotic arrival never actually arrives. */
const MIN_VEL = 14;
/**
 * Time constant of the turn, seconds: the dog is ~95% of the way round after 3× this. Short enough
 * that a corner reads as a swivel rather than a pirouette, long enough that you see it happen.
 */
const TURN_TAU = 0.075;
/**
 * How decisively the heading has to point sideways before the dog commits to turning. The room is a
 * 2:1 iso, so a dog walking *into* the screen (lx and ly rising together) has almost no screen-space
 * x — without a deadband it would flutter between facings for the whole diagonal.
 */
const FACE_COMMIT = 0.34;
/**
 * How narrow the dog is allowed to get walking straight at or away from the camera. Not zero: the
 * painter has no rear view, so this is a *suggestion* of foreshortening, not a real one — enough that
 * a diagonal stops reading as a crab, not so much that the dog becomes an edge.
 */
export const MIN_FACE = 0.42;
/** Wake-up stretch and settle-down curl durations (seconds). */
export const STRETCH_S = 1.5;
export const CURL_S = 1.1;
/** Don't bother relocating to a spot closer than this. */
const MIN_TRIP = 80;

export interface PetSpot {
  lx: number;
  ly: number;
  /** Selection weight — sunbeams win by day, rugs by night. */
  w: number;
}

/** How far into a window's light pool the pet settles (matches the beam's bright end, not its faint tail). */
const BEAM_NAP_IN = 60;

/**
 * Candidate nap spots, weighted by daylight: the floor pools under each window's light beam (prime real
 * estate while the sun is up), and the rugs (always good, best at night). Every candidate is checked
 * against the nav grid so the pet never beds down inside furniture.
 */
export function napSpots(daylight: number): PetSpot[] {
  const sunny = daylight > 0.3;
  const beamW = sunny ? 3 : 0.15;
  const rugW = sunny ? 1 : 2;
  const shear = (BEAM_NAP_IN / BEAM_LEN) * BEAM_SHEAR;
  const out: PetSpot[] = [];
  for (const win of WINDOWS) {
    const tC = ((win.t0 + win.t1) / 2) * FLOOR;
    out.push({ lx: BEAM_NAP_IN, ly: tC + shear, w: beamW }); // back-left wall (lx=0) beams throw +lx
    out.push({ lx: tC + shear, ly: BEAM_NAP_IN, w: beamW }); // back-right wall (ly=0) beams throw +ly
  }
  // Rug spots — hand-placed on open weave, clear of the furniture that shares each rug.
  out.push({ lx: NOOK.lx - 24, ly: NOOK.ly + 96, w: rugW }); // nook rug, front arc
  out.push({ lx: RECEPTION.rug.lx - 60, ly: RECEPTION.rug.ly - 40, w: rugW }); // reception rug
  out.push({ lx: MEETING.lx - 110, ly: MEETING.ly + 40, w: rugW }); // meeting rug, off the table's end
  for (const h of HUDDLES) out.push({ lx: h.lx + 58, ly: h.ly - 42, w: rugW }); // huddle rug, between poufs
  // Every candidate so far is checked against the nav grid, so the dog never beds down inside furniture.
  return [...out, ...deskSpots(sunny ? 0.28 : 0.55)].filter((s) => walkable(s.lx, s.ly));
}

/**
 * Naps at somebody's feet — the floor just outside a desk's outer edge, which is where an office dog
 * actually ends up: near a person, out from under the chair.
 *
 * *Beside* rather than *under*, because under is not available. A pod's two rows sit footprint to
 * footprint across their shared screen gap, so a desk's front edge has no floor at all, and its back
 * edge is where the chair and its occupant are. The outer flank is the aisle — open, reachable, and
 * still visibly "at Ada's desk" rather than adrift in the middle of the room.
 *
 * Candidates are filtered against the nav grid like every other spot: a pod parked near a wall or a
 * bookshelf simply offers fewer of them rather than offering one inside the furniture.
 */
function deskSpots(w: number): PetSpot[] {
  const byId = new Map(PODS.map((p) => [p.id, p]));
  const out: PetSpot[] = [];
  for (const slot of DESK_SLOTS) {
    const pod = byId.get(slot.pod);
    if (!pod) continue;
    const ns = pod.axis === 'ns';
    // Across the pod is x for an `ns` pod and y for an `ew` one; step outward from the pod's centre.
    const half = (ns ? DESK_W : DESK_D) / 2;
    const off = half + 26;
    const away = ns ? Math.sign(slot.lx - pod.cx) : Math.sign(slot.ly - pod.cy);
    const lx = ns ? slot.lx + away * off : slot.lx;
    const ly = ns ? slot.ly : slot.ly + away * off;
    if (walkable(lx, ly)) out.push({ lx, ly, w });
  }
  return out;
}

/** A fresh pet, asleep on its favourite rug (or the first walkable spot the room offers). */
export function createPet(rng: () => number = Math.random): PetState {
  const spots = napSpots(1);
  const spot = spots[Math.floor(rng() * spots.length)] ?? { lx: NOOK.lx - 24, ly: NOOK.ly + 96, w: 1 };
  return {
    lx: spot.lx,
    ly: spot.ly,
    mode: 'sleep',
    modeT: 0,
    phase: 0,
    flip: false,
    face: 1,
    faceMag: 1,
    depthSign: 1,
    vel: 0,
    path: [],
    seg: 0,
    plan: 'nap',
    sitFor: 0,
    speed: PET_SPEED,
  };
}

export interface PetBeatOpts {
  /** Current natural-light level (see lighting.ts) — steers day naps into the sunbeams. */
  daylight: number;
  /** Floor spots beside members currently working — the pet sometimes sits with them, supervising. */
  workSpots?: P[];
  rng?: () => number;
}

/**
 * Stir the pet (called on the office's ambient-beat timer): wake, pick a destination — usually the best
 * nap spot for the hour, sometimes a working member's side — and set off via the nav grid. No-ops unless
 * the pet is settled (asleep or mid-sit); returns whether a move actually started, so the caller knows
 * to keep the frame loop alive.
 */
export function petBeat(pet: PetState, opts: PetBeatOpts): boolean {
  if (pet.mode !== 'sleep' && pet.mode !== 'sit') return false;
  const rng = opts.rng ?? Math.random;

  // Every so often the beat is pure nonsense instead of a destination.
  if (rng() < 0.12 && zoomies(pet, rng)) return true;

  let target: P | null = null;
  let plan: PetState['plan'] = 'nap';
  // Filter to spots the nav grid says are open floor — findPath tolerates blocked endpoints (it steps
  // out to free ground), but a pet *settling* inside a chair footprint would draw inside the chair.
  const work = (opts.workSpots ?? []).filter((s) => walkable(s.lx, s.ly));
  if (work.length && rng() < 0.35) {
    // Go supervise: sit beside someone who is working for a good while, then settle where it stands.
    target = work[Math.floor(rng() * work.length)]!;
    plan = 'sit-then-nap';
    pet.sitFor = 8 + rng() * 6;
  } else {
    const spots = napSpots(opts.daylight);
    let total = 0;
    for (const s of spots) total += s.w;
    let pick = rng() * total;
    for (const s of spots) {
      pick -= s.w;
      if (pick <= 0) {
        target = s;
        break;
      }
    }
    target ??= spots[spots.length - 1] ?? null;
    plan = rng() < 0.3 ? 'sit-then-nap' : 'nap';
    pet.sitFor = 3 + rng() * 4;
  }
  return setOff(pet, target, plan, MIN_TRIP);
}

/**
 * Route the pet to `target` and start the wake-stretch that precedes every trip. Refuses a trip shorter
 * than `minTrip` — a dog that hauls itself up to move a foot and a half looks broken, not alive.
 */
function setOff(pet: PetState, target: P | null, plan: PetState['plan'], minTrip: number): boolean {
  if (!target || Math.hypot(target.lx - pet.lx, target.ly - pet.ly) < minTrip) return false;
  pet.path = findPath({ lx: pet.lx, ly: pet.ly }, { lx: target.lx, ly: target.ly });
  pet.seg = 0;
  pet.plan = plan;
  pet.mode = 'stretch';
  pet.modeT = 0;
  pet.speed = PET_SPEED;
  pet.vel = 0; // out of the stretch it winds up from standing, never from full pace
  return true;
}

/** How many corners a lap of zoomies takes before the dog flops back down. */
const DASH_LEGS: [number, number] = [3, 5];
/** How far apart those corners have to be — a lap of tiny hops is a twitch, not a tear. */
const DASH_MIN_LEG = 170;

/**
 * Zoomies: a fast, pointless lap of the room, ending wherever it ends.
 *
 * The one behaviour with no destination and no reason, which is exactly why the room needs it — every
 * other trip the dog makes is *for* something (a sunbeam, the door, someone working), and an animal
 * that only ever moves with purpose reads as a machine. Routed on the same nav grid as everything
 * else, so a tearing dog still goes around the furniture rather than through it.
 */
function zoomies(pet: PetState, rng: () => number): boolean {
  const legs = DASH_LEGS[0] + Math.floor(rng() * (DASH_LEGS[1] - DASH_LEGS[0] + 1));
  const path: P[] = [{ lx: pet.lx, ly: pet.ly }];
  let at: P = { lx: pet.lx, ly: pet.ly };
  for (let i = 0; i < legs; i++) {
    let hop: P | null = null;
    for (let tries = 0; tries < 24 && !hop; tries++) {
      const p = { lx: rng() * FLOOR, ly: rng() * FLOOR };
      if (walkable(p.lx, p.ly) && Math.hypot(p.lx - at.lx, p.ly - at.ly) > DASH_MIN_LEG) hop = p;
    }
    if (!hop) break;
    // Route each corner properly and splice the waypoints in, so the lap follows the aisles.
    path.push(...findPath(at, hop).slice(1));
    at = hop;
  }
  if (path.length < 3) return false;
  pet.path = path;
  pet.seg = 0;
  pet.plan = 'nap';
  pet.mode = 'stretch';
  pet.modeT = 0;
  pet.speed = PET_DASH;
  pet.vel = 0;
  return true;
}

/**
 * Somebody is carrying food to the lounge. The dog abandons whatever it had planned, follows them to
 * the seat and sits facing it for the length of the meal — the least dignified and most doglike thing
 * it does. Interrupts a trip in progress for the same reason greeting the door does: a dog that
 * finishes its errand before noticing your sandwich is not a dog.
 */
export function petBeg(pet: PetState, seat: P, rng: () => number = Math.random): boolean {
  if (pet.mode === 'stretch' || pet.mode === 'curl') return false; // mid-transition — let it finish
  const spot = besideSpot(seat);
  pet.sitFor = 14 + rng() * 8; // the length of a meal, near enough
  if (setOff(pet, spot, 'sit-then-nap', MIN_TRIP)) return true;
  // Already parked next to the food. Sit up and stare at it, which is the whole behaviour anyway.
  if (pet.mode === 'sleep' || pet.mode === 'sit') {
    faceToward(pet, seat);
    pet.mode = 'sit';
    pet.modeT = 0;
    return true;
  }
  return false;
}

/** Face the pet toward a point (screen-space x grows with lx − ly under the 2:1 iso). */
function faceToward(pet: PetState, at: P): void {
  const sx = at.lx - pet.lx - (at.ly - pet.ly);
  if (Math.abs(sx) > 0.5) pet.flip = sx < 0;
  // Turning to LOOK at something is a settled pose, not travel: open the figure back to full profile
  // so a dog that watched you walk past is not left wearing the last stride's foreshortening.
  pet.faceMag = 1;
}

/** How close a walker has to pass before the sleeping dog bothers to open an eye. */
const NOTICE_R = 105;
/** How long it watches a passer-by before flopping back down. */
const NOTICE_S: [number, number] = [3, 4.5];
/** Where the greeter waits: just inside the door, clear of the doorway itself, in preference order. */
const GREET_IN = 64;
function greetSpots(): P[] {
  return [
    { lx: ENTRANCE.lx + GREET_IN, ly: ENTRANCE.ly - GREET_IN * 0.55 },
    { lx: ENTRANCE.lx + GREET_IN, ly: ENTRANCE.ly + GREET_IN * 0.4 },
    { lx: ENTRANCE.lx + GREET_IN * 1.5, ly: ENTRANCE.ly },
  ];
}

/**
 * A member walked close by. The dog lifts its head to watch them pass, then flops back down — the whole
 * behaviour is just `sleep → sit`, because `sit` already means *awake, wagging, watching you*, and
 * `stepPet` already knows how to curl back up afterwards. No new pose, no new mode.
 *
 * This is the cheap half of the office's social pet: it costs one distance check per walker per frame and
 * makes the room feel like it has noticed you. Only a *sleeping* dog notices — one already sitting is
 * watching you anyway, and one mid-trip has somewhere to be.
 */
export function petNotice(pet: PetState, walkers: P[], rng: () => number = Math.random): boolean {
  if (pet.mode !== 'sleep') return false;
  let closest: P | null = null;
  let best = NOTICE_R;
  for (const w of walkers) {
    const d = Math.hypot(w.lx - pet.lx, w.ly - pet.ly);
    if (d < best) {
      best = d;
      closest = w;
    }
  }
  if (!closest) return false;
  faceToward(pet, closest);
  pet.mode = 'sit';
  pet.modeT = 0;
  pet.sitFor = NOTICE_S[0] + rng() * (NOTICE_S[1] - NOTICE_S[0]);
  return true;
}

/**
 * Someone just came through the door. The dog trots over to meet them and sits by the entrance a while —
 * the one behaviour that makes a dog a *dog* rather than a decorative cushion with legs.
 *
 * Unlike the ambient beat this may divert a trip already in progress: a dog on its way to a sunbeam will
 * absolutely abandon it to greet an arrival, and that reprioritisation is the charm of the thing.
 */
export function petGreet(pet: PetState, rng: () => number = Math.random): boolean {
  if (pet.mode === 'stretch' || pet.mode === 'curl') return false; // mid-transition — let it finish
  // Just inside the door (which is on the back-left wall, so inward is +lx), beside the arrival's path
  // rather than in it — a dog underfoot in the doorway is a different kind of office story.
  const spot = greetSpots().find((s) => walkable(s.lx, s.ly)) ?? null;
  pet.sitFor = 7 + rng() * 5; // a good long wait by the door — greeting is worth being late to a nap for
  if (setOff(pet, spot, 'sit-then-nap', MIN_TRIP)) return true;
  // No trip worth taking — it's already by the door. That's no reason to sleep through an arrival, though:
  // sit up and watch it open. (A dog mid-trip elsewhere keeps its own plans and is left alone.)
  if (pet.mode === 'sleep' || pet.mode === 'sit') {
    faceToward(pet, ENTRANCE);
    pet.mode = 'sit';
    pet.modeT = 0;
    return true;
  }
  return false;
}

/**
 * A member set off across the room — the dog tags along and sits with them wherever they end up. Gated on
 * the pet being settled (a greeting outranks a stroll; a trip already underway keeps its own destination).
 */
export function petFollow(pet: PetState, dest: P, rng: () => number = Math.random): boolean {
  if (pet.mode !== 'sleep' && pet.mode !== 'sit') return false;
  const spot = besideSpot(dest);
  pet.sitFor = 6 + rng() * 5;
  return setOff(pet, spot, 'sit-then-nap', MIN_TRIP);
}

/** How far off a destination the dog parks itself — close enough to be *with* you, not underfoot. */
const BESIDE_OFF = 52;

/**
 * Open floor beside `at`, hunted around a ring. A destination worth following someone to is usually a thing
 * — the coffee machine, a desk — so the point itself is inside furniture and so, often, is the first side
 * we try; walking the ring finds the side that's actually free. Null if the spot is boxed in entirely.
 */
function besideSpot(at: P): P | null {
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const p = { lx: at.lx + Math.cos(a) * BESIDE_OFF, ly: at.ly + Math.sin(a) * BESIDE_OFF };
    if (walkable(p.lx, p.ly)) return p;
  }
  return null;
}

/** Path length still ahead of the pet, following the waypoints rather than cutting the corner. */
function remaining(pet: PetState): number {
  let d = 0;
  let at: P = { lx: pet.lx, ly: pet.ly };
  for (let i = pet.seg + 1; i < pet.path.length; i++) {
    const next = pet.path[i]!;
    d += Math.hypot(next.lx - at.lx, next.ly - at.ly);
    at = next;
  }
  return d;
}

/**
 * Advance the pet by `dt` seconds. Returns whether the pet still needs animation frames — false only
 * when it is asleep and square-on to its intended facing, which is the office's cue that the room can
 * park on a baked still frame again.
 */
export function stepPet(pet: PetState, dt: number): boolean {
  pet.modeT += dt;
  // The turn runs under every mode and outlives the one that started it — a dog told to look at the
  // door while it settles keeps turning through the settle. Exponential toward the intent, so the
  // swivel is fast off the mark and lands soft; snapped the last sliver so it terminates exactly and
  // the room can still park its frame loop.
  const want = (pet.flip ? -1 : 1) * pet.faceMag;
  if (pet.face !== want) {
    pet.face += (want - pet.face) * (1 - Math.exp(-dt / TURN_TAU));
    if (Math.abs(want - pet.face) < 0.004) pet.face = want;
  }
  const turning = pet.face !== want;

  switch (pet.mode) {
    case 'sleep':
      return turning;
    case 'stretch':
      if (pet.modeT >= STRETCH_S) {
        pet.mode = 'walk';
        pet.modeT = 0;
      }
      return true;
    case 'walk': {
      // Ease toward the trip's pace, braking for the arrival — `remaining` is the real path length
      // left, not the crow-flies distance, so a dog rounding one last corner does not brake early.
      const target = Math.max(MIN_VEL, Math.min(pet.speed, (remaining(pet) / BRAKE_D) * pet.speed));
      pet.vel += Math.sign(target - pet.vel) * Math.min(ACCEL * dt, Math.abs(target - pet.vel));
      let travel = pet.vel * dt;
      while (travel > 0 && pet.seg < pet.path.length - 1) {
        const next = pet.path[pet.seg + 1]!;
        const dx = next.lx - pet.lx;
        const dy = next.ly - pet.ly;
        const d = Math.hypot(dx, dy);
        if (d < 1e-6) {
          pet.seg++;
          continue;
        }
        const step = Math.min(d, travel);
        pet.lx += (dx / d) * step;
        pet.ly += (dy / d) * step;
        pet.phase += step / STRIDE; // gait from distance, never wall time
        // Screen-space heading under the 2:1 iso: x grows with (lx − ly). Only a heading that points
        // decisively sideways changes the facing SIGN: a leg angled into the screen has a screen-x of
        // almost nothing, and honouring it would spin the dog on its own axis down a diagonal.
        const sx = dx - dy;
        if (Math.abs(sx) > FACE_COMMIT * d) pet.flip = sx < 0;
        // …but the WIDTH follows the heading continuously, with no deadband — that is what stops a
        // diagonal reading as a crab.
        //
        // Measured in SCREEN space, not floor space, because that is where the dog is drawn. Under
        // the 2:1 iso even a pure +lx heading travels down-and-right on screen, so "how side-on am
        // I" is the fraction of the screen velocity that is horizontal — 1 only when the vertical
        // component vanishes (the +lx/−ly axis, straight across the room), sinking to the floor when
        // the dog comes at the camera down the +lx/+ly diagonal.
        const vx = (dx - dy) * KX;
        const vy = (dx + dy) * KY;
        pet.faceMag = Math.max(MIN_FACE, Math.abs(vx) / (Math.hypot(vx, vy) || 1));
        // Toward or away? Committed only when the vertical component clearly dominates the noise —
        // the same deadband idea as FACE_COMMIT, so the front/back view can't flutter.
        if (Math.abs(vy) > 0.3 * (Math.hypot(vx, vy) || 1)) pet.depthSign = vy > 0 ? 1 : -1;
        travel -= step;
        if (step >= d) pet.seg++;
      }
      if (pet.seg >= pet.path.length - 1) {
        pet.mode = pet.plan === 'sit-then-nap' ? 'sit' : 'curl';
        pet.modeT = 0;
        pet.vel = 0;
        // Settled poses are drawn side-on and are meant to be read that way — a napping dog held at
        // a walking heading's foreshortening just looks squashed. Arriving opens the figure back out,
        // through the same eased turn.
        pet.faceMag = 1;
      }
      return true;
    }
    case 'sit':
      if (pet.modeT >= pet.sitFor) {
        pet.mode = 'curl';
        pet.modeT = 0;
      }
      return true;
    case 'curl':
      if (pet.modeT >= CURL_S) {
        pet.mode = 'sleep';
        pet.modeT = 0;
      }
      return true;
  }
}
