import { describe, expect, it } from 'vitest';
import { towardnessFor } from './render';

describe('the turn never shows a bare squashed billboard', () => {
  it('starts the chest-on crossfade before the profile squashes past half width', () => {
    // The paper band was |face| between 1.0 and 0.55: squashed profile, no chest-on view yet. The
    // fade now starts at 0.75, so the unshaded squash range a viewer can see is much narrower.
    expect(towardnessFor(0.7)).toBeGreaterThan(0);
    expect(towardnessFor(0.8)).toBe(0);
  });

  it('is fully chest-on above the ribcage floor, so the sliver underneath is never visible', () => {
    // drawDog floors the mirror at 0.16 — by then this must be 1 or the floor itself would show.
    expect(towardnessFor(0.35)).toBe(1);
    expect(towardnessFor(0.16)).toBe(1);
  });

  it('is symmetric — a leftward turn fades exactly like a rightward one', () => {
    expect(towardnessFor(-0.5)).toBe(towardnessFor(0.5));
  });
});
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
  MIN_FACE,
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

  /**
   * The dog winds up to PET_SPEED rather than starting at it — but it does get there, and it does not
   * exceed it. Asserted over a stretch of open road (not the first tick), because the first tick is
   * precisely the ramp this is checking exists.
   */
  it('winds up to PET_SPEED and holds it mid-trip', () => {
    const pet = wakePet(13);
    runUntil(pet, 'walk');
    const first = pet.vel;
    for (let i = 0; i < 30 && pet.mode === 'walk'; i++) stepPet(pet, 1 / 60);
    expect(first).toBeLessThan(PET_SPEED);
    if (pet.mode !== 'walk') return;
    expect(pet.vel).toBeCloseTo(PET_SPEED, 5);
    const x0 = pet.lx;
    const y0 = pet.ly;
    stepPet(pet, 0.1);
    if (pet.mode === 'walk') {
      expect(Math.hypot(pet.lx - x0, pet.ly - y0)).toBeCloseTo(PET_SPEED * 0.1, 0);
    }
  });

  /** ...and sheds it again on the way in, so it does not stop dead on the last stride. */
  it('brakes into the arrival instead of stopping dead', () => {
    const pet = wakePet(13);
    runUntil(pet, 'walk');
    let slowest = Infinity;
    for (let i = 0; i < 2000 && pet.mode === 'walk'; i++) {
      stepPet(pet, 1 / 60);
      if (pet.mode === 'walk') slowest = Math.min(slowest, pet.vel);
    }
    expect(pet.mode).not.toBe('walk');
    expect(slowest).toBeLessThan(PET_SPEED); // it was still slowing when it got there
  });
});

/**
 * Turning. The facing INTENT (`flip`) snaps the moment the heading decides; the facing that is DRAWN
 * (`face`) chases it, which is what makes a change of direction a swivel rather than a teleport.
 */
describe('turning', () => {
  it('eases the drawn facing toward the intent rather than snapping it', () => {
    const pet = createPet(() => 0.5);
    pet.flip = true; // "turn and look left"
    stepPet(pet, 1 / 60);
    expect(pet.face).toBeLessThan(1); // it has started to turn
    expect(pet.face).toBeGreaterThan(-1); // and is nowhere near done
    for (let i = 0; i < 60; i++) stepPet(pet, 1 / 60);
    expect(pet.face).toBe(-1); // lands exactly, so the room can park its frame loop
  });

  it('keeps the room awake through a turn a sleeping dog started', () => {
    const pet = createPet(() => 0.5);
    expect(stepPet(pet, 1 / 60)).toBe(false); // settled and square-on: nothing to draw
    pet.flip = true;
    expect(stepPet(pet, 1 / 60)).toBe(true); // mid-swivel: it needs frames
    for (let i = 0; i < 60; i++) stepPet(pet, 1 / 60);
    expect(stepPet(pet, 1 / 60)).toBe(false); // and gives them back when it lands
  });

  /**
   * "It looks like hes walking sideways" (nick, 2026-07-28). The dog only has a left and a right
   * view, so on a 2:1 iso a diagonal was drawn fully side-on while travelling at the camera. The
   * width now follows the heading: side-on along a wall, narrow toward the viewer.
   */
  it('narrows toward the camera and opens out along a wall', () => {
    const walkAlong = (tx: number, ty: number) => {
      const pet = createPet(() => 0.5);
      pet.lx = 300;
      pet.ly = 300;
      pet.path = [
        { lx: 300, ly: 300 },
        { lx: tx, ly: ty },
      ];
      pet.seg = 0;
      pet.mode = 'walk';
      for (let i = 0; i < 30 && pet.mode === 'walk'; i++) stepPet(pet, 1 / 60);
      return pet;
    };
    // Measured in SCREEN space. +lx/−ly is the one heading whose screen travel is purely horizontal
    // — straight across the room, fully side-on to the camera.
    expect(walkAlong(500, 100).faceMag).toBeCloseTo(1, 2); // dx = −dy: no screen-y at all
    // +lx/+ly is its opposite: no screen-x at all, straight down the screen at the viewer. As narrow
    // as the painter is allowed to draw it, since it has no rear view to switch to.
    expect(walkAlong(800, 800).faceMag).toBeCloseTo(MIN_FACE, 2);
    // A pure +lx heading is NEITHER — under a 2:1 iso it still travels down-and-right on screen, so
    // it sits between the two. This is the case that made the first version of this wrong: measured
    // on the floor it looks like the side-on extreme, and it is not.
    const alongOneAxis = walkAlong(800, 300).faceMag;
    expect(alongOneAxis).toBeGreaterThan(MIN_FACE);
    expect(alongOneAxis).toBeLessThan(1);
  });

  it('opens back to full profile when it turns to look at something', () => {
    const pet = createPet(() => 0.5);
    pet.faceMag = MIN_FACE; // left over from a diagonal it just finished
    // petNotice is the cheapest route to faceToward: a walker passes, the dog looks up.
    expect(petNotice(pet, [{ lx: pet.lx - 40, ly: pet.ly }], () => 0.5)).toBe(true);
    expect(pet.faceMag).toBe(1);
  });

  it('holds its facing down a diagonal instead of fluttering', () => {
    // Screen-space x is (lx − ly), so a route heading equally in +lx and +ly is walking straight INTO
    // the screen: no honest facing exists, and the dog must simply keep the one it had.
    const pet = createPet(() => 0.5);
    pet.lx = 300;
    pet.ly = 300;
    pet.path = [
      { lx: 300, ly: 300 },
      { lx: 500, ly: 500 },
    ];
    pet.seg = 0;
    pet.mode = 'walk';
    pet.flip = true;
    for (let i = 0; i < 200 && pet.mode === 'walk'; i++) stepPet(pet, 1 / 60);
    expect(pet.flip).toBe(true);
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
