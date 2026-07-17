import { describe, expect, it } from 'vitest';
import { PET_SPEED, petBeat, createPet, CURL_S, napSpots, stepPet, STRETCH_S, type PetState } from './pet';
import { walkable } from './nav';

/** A tiny deterministic LCG so behaviour tests never depend on Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function wakePet(seed = 7, daylight = 1): PetState {
  const rng = lcg(seed);
  const pet = createPet(rng);
  // Try a few beats — a given rng draw may pick a spot too close to bother relocating to.
  for (let i = 0; i < 20 && pet.mode === 'sleep'; i++) petBeat(pet, { daylight, rng });
  expect(pet.mode).toBe('stretch');
  return pet;
}

/** Run the pet forward until it reaches `mode` (bounded so a broken machine fails, not hangs). */
function runUntil(pet: PetState, mode: PetState['mode'], maxS = 120): number {
  let t = 0;
  const dt = 1 / 30;
  while (pet.mode !== mode && t < maxS) {
    stepPet(pet, dt);
    t += dt;
  }
  expect(pet.mode).toBe(mode);
  return t;
}

describe('napSpots', () => {
  it('only offers spots on open floor', () => {
    for (const daylight of [0, 0.5, 1]) {
      const spots = napSpots(daylight);
      expect(spots.length).toBeGreaterThan(0);
      for (const s of spots) expect(walkable(s.lx, s.ly)).toBe(true);
    }
  });

  it('weights the window sunbeams up by day and down at night', () => {
    const day = napSpots(1);
    const night = napSpots(0);
    const beamWeight = (spots: ReturnType<typeof napSpots>) =>
      spots.filter((s) => s.lx <= 70 || s.ly <= 70).reduce((a, s) => a + s.w, 0);
    expect(beamWeight(day)).toBeGreaterThan(beamWeight(night));
  });
});

describe('createPet', () => {
  it('starts asleep on a walkable spot, needing no animation frames', () => {
    const pet = createPet(lcg(3));
    expect(pet.mode).toBe('sleep');
    expect(walkable(pet.lx, pet.ly)).toBe(true);
    expect(stepPet(pet, 1 / 60)).toBe(false); // asleep = the room may park on its baked frame
  });
});

describe('petBeat', () => {
  it('wakes a sleeping pet into a stretch with a real route', () => {
    const pet = wakePet();
    expect(pet.path.length).toBeGreaterThanOrEqual(2);
    const end = pet.path[pet.path.length - 1]!;
    expect(Math.hypot(end.lx - pet.path[0]!.lx, end.ly - pet.path[0]!.ly)).toBeGreaterThanOrEqual(80);
  });

  it('does not stir a pet already on the move', () => {
    const pet = wakePet();
    const path = pet.path;
    expect(petBeat(pet, { daylight: 1, rng: lcg(9) })).toBe(false);
    expect(pet.path).toBe(path); // untouched
  });

  it('only settles at walkable work-side spots', () => {
    const rng = () => 0.1; // forces the supervise branch and the first spot
    const pet = createPet(lcg(5));
    const blocked = { lx: 450, ly: 350 }; // the huddle table footprint — solid
    expect(walkable(blocked.lx, blocked.ly)).toBe(false);
    // With only a blocked work spot on offer, the beat falls through to nap spots — never the furniture.
    petBeat(pet, { daylight: 1, workSpots: [blocked], rng });
    if (pet.mode === 'stretch') {
      const end = pet.path[pet.path.length - 1]!;
      expect(end.lx === blocked.lx && end.ly === blocked.ly).toBe(false);
    }
  });
});

describe('stepPet', () => {
  it('walks the full arc: stretch → walk → settle → sleep, then rests', () => {
    const pet = wakePet();
    const dest = pet.path[pet.path.length - 1]!;
    runUntil(pet, 'walk');
    runUntil(pet, 'sleep');
    expect(Math.hypot(pet.lx - dest.lx, pet.ly - dest.ly)).toBeLessThan(1);
    expect(stepPet(pet, 1 / 60)).toBe(false);
  });

  it('takes the stretch and curl beats at their configured durations', () => {
    const pet = wakePet();
    pet.plan = 'nap'; // pin the arrival branch — some rng draws sit first
    const tWalk = runUntil(pet, 'walk');
    expect(tWalk).toBeGreaterThanOrEqual(STRETCH_S - 0.1);
    runUntil(pet, 'curl');
    const tSleep = runUntil(pet, 'sleep');
    expect(tSleep).toBeGreaterThanOrEqual(CURL_S - 0.1);
  });

  it('advances gait phase by distance travelled, not wall time', () => {
    // Same route stepped at 30fps and at 6fps must land on the same phase — the no-skate rule.
    const a = wakePet(11);
    const b = wakePet(11);
    expect(b.path).toEqual(a.path);
    runUntil(a, 'walk');
    runUntil(b, 'walk');
    for (let i = 0; i < 1800 && a.mode === 'walk'; i++) stepPet(a, 1 / 30);
    for (let i = 0; i < 360 && b.mode === 'walk'; i++) stepPet(b, 1 / 6);
    expect(a.mode).not.toBe('walk');
    expect(b.mode).not.toBe('walk');
    expect(b.phase).toBeCloseTo(a.phase, 5);
  });

  it('covers ground at PET_SPEED while walking', () => {
    const pet = wakePet(13);
    runUntil(pet, 'walk');
    const x0 = pet.lx;
    const y0 = pet.ly;
    stepPet(pet, 0.1);
    if (pet.mode === 'walk') {
      expect(Math.hypot(pet.lx - x0, pet.ly - y0)).toBeCloseTo(PET_SPEED * 0.1, 0);
    }
  });
});
