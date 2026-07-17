import { FLOOR } from './iso';
import { BEAM_LEN, BEAM_SHEAR, ENTRANCE, HUDDLES, MEETING, NOOK, RECEPTION, WINDOWS } from './layout';
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
  /** Screen-space facing: true = the pet points left. */
  flip: boolean;
  /** Current route (waypoints, ends exact) and the segment index into it. */
  path: P[];
  seg: number;
  /** What to do on arrival: settle straight down, or sit a while first. */
  plan: 'nap' | 'sit-then-nap';
  /** How long the arrival sit lasts (seconds), when the plan includes one. */
  sitFor: number;
}

/** Walking speed, logical units/s — an unhurried pad, slower than the members. */
export const PET_SPEED = 55;
/** One full gait cycle per this much ground covered. */
const STRIDE = 30;
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
  return out.filter((s) => walkable(s.lx, s.ly));
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
    path: [],
    seg: 0,
    plan: 'nap',
    sitFor: 0,
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
  return true;
}

/** Face the pet toward a point (screen-space x grows with lx − ly under the 2:1 iso). */
function faceToward(pet: PetState, at: P): void {
  const sx = at.lx - pet.lx - (at.ly - pet.ly);
  if (Math.abs(sx) > 0.5) pet.flip = sx < 0;
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

/**
 * Advance the pet by `dt` seconds. Returns whether the pet still needs animation frames — false only
 * when it is asleep, which is the office's cue that the room can park on a baked still frame again.
 */
export function stepPet(pet: PetState, dt: number): boolean {
  pet.modeT += dt;
  switch (pet.mode) {
    case 'sleep':
      return false;
    case 'stretch':
      if (pet.modeT >= STRETCH_S) {
        pet.mode = 'walk';
        pet.modeT = 0;
      }
      return true;
    case 'walk': {
      let travel = PET_SPEED * dt;
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
        // Screen-space heading under the 2:1 iso: x grows with (lx − ly).
        const sx = dx - dy;
        if (Math.abs(sx) > 0.5) pet.flip = sx < 0;
        travel -= step;
        if (step >= d) pet.seg++;
      }
      if (pet.seg >= pet.path.length - 1) {
        pet.mode = pet.plan === 'sit-then-nap' ? 'sit' : 'curl';
        pet.modeT = 0;
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
