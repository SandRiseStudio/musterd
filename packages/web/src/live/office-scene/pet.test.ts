import { describe, expect, it } from 'vitest';
import {
  createPet,
  CURL_S,
  napSpots,
  petBeat,
  petFollow,
  petGreet,
  petNotice,
  petBeg,
  PET_DASH,
  PET_SPEED,
  stepPet,
  STRETCH_S,
  type PetState,
} from './pet';
import { COFFEE_STAND, DESK_SLOTS, ENTRANCE, NOOK } from './layout';
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
    // Rugs, sunbeams and the floor beside each desk — never inside the furniture. The desk-side spots
    // are filtered against the same grid, so a pod parked against a wall just offers fewer of them.
    for (const daylight of [0, 0.5, 1]) {
      const spots = napSpots(daylight);
      expect(spots.length).toBeGreaterThan(0);
      for (const s of spots) expect(walkable(s.lx, s.ly)).toBe(true);
    }
  });

  it('offers a spot at somebody\'s desk, not only the rugs', () => {
    // The dog napping at a desk is the beat that makes the room feel worked in rather than decorated.
    const spots = napSpots(1);
    const nearADesk = spots.some((s) =>
      DESK_SLOTS.some((d) => Math.hypot(d.lx - s.lx, d.ly - s.ly) < 90),
    );
    expect(nearADesk).toBe(true);
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

/** The social half of the dog: it notices passers-by, greets arrivals, and tags along on a coffee run. */
describe('petNotice (the dog watches you walk past)', () => {
  it('wakes a sleeping dog into a sit when someone passes close by', () => {
    const pet = createPet(lcg(3));
    expect(petNotice(pet, [{ lx: pet.lx + 30, ly: pet.ly + 20 }], lcg(1))).toBe(true);
    expect(pet.mode).toBe('sit');
    // It watches them by, then puts itself back to bed — no new pose, the existing sit→curl→sleep tail.
    runUntil(pet, 'curl');
    runUntil(pet, 'sleep');
  });

  it('ignores someone walking past on the far side of the room', () => {
    const pet = createPet(lcg(3));
    expect(petNotice(pet, [{ lx: pet.lx + 400, ly: pet.ly + 400 }], lcg(1))).toBe(false);
    expect(pet.mode).toBe('sleep');
  });

  it('does not interrupt a dog already on a trip', () => {
    const pet = wakePet();
    runUntil(pet, 'walk');
    const path = pet.path;
    expect(petNotice(pet, [{ lx: pet.lx + 10, ly: pet.ly }], lcg(1))).toBe(false);
    expect(pet.mode).toBe('walk');
    expect(pet.path).toBe(path);
  });

  it('turns to face the passer-by', () => {
    // Screen-space x grows with (lx − ly), so a walker at −lx/+ly is to the dog's left → flip.
    const pet = createPet(lcg(3));
    pet.flip = false;
    petNotice(pet, [{ lx: pet.lx - 40, ly: pet.ly + 40 }], lcg(1));
    expect(pet.flip).toBe(true);
  });
});

describe('petGreet (someone came through the door)', () => {
  it('sets off for the entrance and plans a good long wait there', () => {
    const pet = createPet(lcg(3));
    // Park it deliberately far from the door rather than wherever the seeded nap-spot draw lands: the
    // behaviour under test is "walks over to greet", and a dog that happens to start beside the
    // entrance correctly takes the no-trip-needed branch instead.
    pet.lx = NOOK.lx;
    pet.ly = NOOK.ly + 96;
    expect(petGreet(pet, lcg(2))).toBe(true);
    expect(pet.mode).toBe('stretch');
    expect(pet.plan).toBe('sit-then-nap');
    expect(pet.sitFor).toBeGreaterThan(6);
    const end = pet.path[pet.path.length - 1]!;
    expect(Math.hypot(end.lx - ENTRANCE.lx, end.ly - ENTRANCE.ly)).toBeLessThan(120);
    expect(walkable(end.lx, end.ly)).toBe(true);
  });

  it('abandons a nap trip already in flight — a greeting outranks a sunbeam', () => {
    const pet = wakePet();
    runUntil(pet, 'walk');
    pet.lx = NOOK.lx; // mid-trip and well across the room from the door
    pet.ly = NOOK.ly + 96;
    expect(petGreet(pet, lcg(2))).toBe(true);
    const end = pet.path[pet.path.length - 1]!;
    expect(Math.hypot(end.lx - ENTRANCE.lx, end.ly - ENTRANCE.ly)).toBeLessThan(120);
  });

  it('sits up and watches the door when it is already too close to bother walking', () => {
    const pet = createPet(lcg(3));
    pet.lx = ENTRANCE.lx + 60; // dozing right by the entrance — no trip worth taking
    pet.ly = ENTRANCE.ly - 30;
    expect(petGreet(pet, lcg(2))).toBe(true);
    expect(pet.mode).toBe('sit'); // not asleep through an arrival
    expect(pet.path).toEqual([]); // and it didn't walk anywhere to do it
  });

  it('lets a stretch or a curl finish rather than snapping out of it', () => {
    const pet = wakePet(); // mid-stretch
    expect(petGreet(pet, lcg(2))).toBe(false);
  });
});

describe('petFollow (tagging along on a coffee run)', () => {
  it('trots after a strolling member and settles beside where they land', () => {
    const pet = createPet(lcg(3));
    expect(petFollow(pet, COFFEE_STAND, lcg(4))).toBe(true);
    expect(pet.plan).toBe('sit-then-nap');
    const end = pet.path[pet.path.length - 1]!;
    expect(walkable(end.lx, end.ly)).toBe(true);
    // Beside them, not on top of them — and not so far away it isn't following at all.
    const off = Math.hypot(end.lx - COFFEE_STAND.lx, end.ly - COFFEE_STAND.ly);
    expect(off).toBeGreaterThan(0); // beside them, not on top of them
    expect(off).toBeLessThan(70); // and near enough to read as together
  });

  it('will not abandon a trip it is already on (a greeting outranks a stroll)', () => {
    const pet = wakePet();
    runUntil(pet, 'walk');
    const path = pet.path;
    expect(petFollow(pet, COFFEE_STAND, lcg(4))).toBe(false);
    expect(pet.path).toBe(path);
  });
});

describe('petBeg (somebody is carrying food to the lounge)', () => {
  const seat = { lx: NOOK.lx + 40, ly: NOOK.ly + 6 };

  it('sets off for the meal and plans to sit through the whole thing', () => {
    const pet = createPet(lcg(3));
    pet.lx = 120; // across the room from the lounge
    pet.ly = 620;
    expect(petBeg(pet, seat, lcg(4))).toBe(true);
    expect(pet.plan).toBe('sit-then-nap');
    // A meal is a long stare, not the glance it gives a passer-by.
    expect(pet.sitFor).toBeGreaterThan(12);
    const end = pet.path[pet.path.length - 1]!;
    expect(Math.hypot(end.lx - seat.lx, end.ly - seat.ly)).toBeLessThan(90);
    expect(walkable(end.lx, end.ly)).toBe(true);
  });

  it('just sits up and stares when it is already next to the food', () => {
    const pet = createPet(lcg(3));
    pet.lx = seat.lx + 30;
    pet.ly = seat.ly + 20;
    expect(petBeg(pet, seat, lcg(4))).toBe(true);
    expect(pet.mode).toBe('sit');
    expect(pet.path).toEqual([]);
  });

  it('lets a stretch finish rather than snapping out of it', () => {
    const pet = wakePet();
    expect(pet.mode).toBe('stretch');
    expect(petBeg(pet, seat, lcg(4))).toBe(false);
  });
});

describe('zoomies', () => {
  /** Force the beat down the zoomies branch: the first draw decides it (< 0.12). */
  function dashRng(): () => number {
    let n = 0;
    return () => (n++ === 0 ? 0.01 : Math.random());
  }

  it('tears a multi-corner lap at dash speed and still ends up asleep', () => {
    const pet = createPet(lcg(3));
    expect(petBeat(pet, { daylight: 1, rng: dashRng() })).toBe(true);
    expect(pet.speed).toBe(PET_DASH);
    // A lap, not a hop: several corners strung together.
    expect(pet.path.length).toBeGreaterThan(3);
    runUntil(pet, 'walk');
    runUntil(pet, 'sleep', 240); // and it always winds down again — no permanently awake dog
    expect(stepPet(pet, 1 / 60)).toBe(false);
  });

  it('routes the lap around the furniture like any other trip', () => {
    const pet = createPet(lcg(3));
    petBeat(pet, { daylight: 1, rng: dashRng() });
    for (const p of pet.path) expect(walkable(p.lx, p.ly)).toBe(true);
  });

  it('goes back to a walking pace on the next ordinary trip', () => {
    const pet = createPet(lcg(3));
    petBeat(pet, { daylight: 1, rng: dashRng() });
    runUntil(pet, 'sleep', 240);
    for (let i = 0; i < 40 && pet.mode === 'sleep'; i++) petBeat(pet, { daylight: 1, rng: lcg(21 + i) });
    expect(pet.speed).toBe(PET_SPEED);
  });
});
