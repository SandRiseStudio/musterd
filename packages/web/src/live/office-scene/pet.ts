import { FLOOR } from './iso';
import { BEAM_LEN, BEAM_SHEAR, HUDDLES, MEETING, NOOK, RECEPTION, WINDOWS } from './layout';
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
  if (!target || Math.hypot(target.lx - pet.lx, target.ly - pet.ly) < MIN_TRIP) return false;

  pet.path = findPath({ lx: pet.lx, ly: pet.ly }, { lx: target.lx, ly: target.ly });
  pet.seg = 0;
  pet.plan = plan;
  pet.mode = 'stretch';
  pet.modeT = 0;
  return true;
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
