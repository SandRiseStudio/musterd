import { describe, expect, it } from 'vitest';
import { CAT_SPEED, catBeat, createCat, CURL_S, napSpots, stepCat, STRETCH_S, type CatState } from './cat';
import { walkable } from './nav';

/** A tiny deterministic LCG so behaviour tests never depend on Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function wakeCat(seed = 7, daylight = 1): CatState {
  const rng = lcg(seed);
  const cat = createCat(rng);
  // Try a few beats — a given rng draw may pick a spot too close to bother relocating to.
  for (let i = 0; i < 20 && cat.mode === 'sleep'; i++) catBeat(cat, { daylight, rng });
  expect(cat.mode).toBe('stretch');
  return cat;
}

/** Run the cat forward until it reaches `mode` (bounded so a broken machine fails, not hangs). */
function runUntil(cat: CatState, mode: CatState['mode'], maxS = 120): number {
  let t = 0;
  const dt = 1 / 30;
  while (cat.mode !== mode && t < maxS) {
    stepCat(cat, dt);
    t += dt;
  }
  expect(cat.mode).toBe(mode);
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

describe('createCat', () => {
  it('starts asleep on a walkable spot, needing no animation frames', () => {
    const cat = createCat(lcg(3));
    expect(cat.mode).toBe('sleep');
    expect(walkable(cat.lx, cat.ly)).toBe(true);
    expect(stepCat(cat, 1 / 60)).toBe(false); // asleep = the room may park on its baked frame
  });
});

describe('catBeat', () => {
  it('wakes a sleeping cat into a stretch with a real route', () => {
    const cat = wakeCat();
    expect(cat.path.length).toBeGreaterThanOrEqual(2);
    const end = cat.path[cat.path.length - 1]!;
    expect(Math.hypot(end.lx - cat.path[0]!.lx, end.ly - cat.path[0]!.ly)).toBeGreaterThanOrEqual(80);
  });

  it('does not stir a cat already on the move', () => {
    const cat = wakeCat();
    const path = cat.path;
    expect(catBeat(cat, { daylight: 1, rng: lcg(9) })).toBe(false);
    expect(cat.path).toBe(path); // untouched
  });

  it('only settles at walkable work-side spots', () => {
    const rng = () => 0.1; // forces the supervise branch and the first spot
    const cat = createCat(lcg(5));
    const blocked = { lx: 450, ly: 350 }; // the huddle table footprint — solid
    expect(walkable(blocked.lx, blocked.ly)).toBe(false);
    // With only a blocked work spot on offer, the beat falls through to nap spots — never the furniture.
    catBeat(cat, { daylight: 1, workSpots: [blocked], rng });
    if (cat.mode === 'stretch') {
      const end = cat.path[cat.path.length - 1]!;
      expect(end.lx === blocked.lx && end.ly === blocked.ly).toBe(false);
    }
  });
});

describe('stepCat', () => {
  it('walks the full arc: stretch → walk → settle → sleep, then rests', () => {
    const cat = wakeCat();
    const dest = cat.path[cat.path.length - 1]!;
    runUntil(cat, 'walk');
    runUntil(cat, 'sleep');
    expect(Math.hypot(cat.lx - dest.lx, cat.ly - dest.ly)).toBeLessThan(1);
    expect(stepCat(cat, 1 / 60)).toBe(false);
  });

  it('takes the stretch and curl beats at their configured durations', () => {
    const cat = wakeCat();
    cat.plan = 'nap'; // pin the arrival branch — some rng draws sit first
    const tWalk = runUntil(cat, 'walk');
    expect(tWalk).toBeGreaterThanOrEqual(STRETCH_S - 0.1);
    runUntil(cat, 'curl');
    const tSleep = runUntil(cat, 'sleep');
    expect(tSleep).toBeGreaterThanOrEqual(CURL_S - 0.1);
  });

  it('advances gait phase by distance travelled, not wall time', () => {
    // Same route stepped at 30fps and at 6fps must land on the same phase — the no-skate rule.
    const a = wakeCat(11);
    const b = wakeCat(11);
    expect(b.path).toEqual(a.path);
    runUntil(a, 'walk');
    runUntil(b, 'walk');
    for (let i = 0; i < 1800 && a.mode === 'walk'; i++) stepCat(a, 1 / 30);
    for (let i = 0; i < 360 && b.mode === 'walk'; i++) stepCat(b, 1 / 6);
    expect(a.mode).not.toBe('walk');
    expect(b.mode).not.toBe('walk');
    expect(b.phase).toBeCloseTo(a.phase, 5);
  });

  it('covers ground at CAT_SPEED while walking', () => {
    const cat = wakeCat(13);
    runUntil(cat, 'walk');
    const x0 = cat.lx;
    const y0 = cat.ly;
    stepCat(cat, 0.1);
    if (cat.mode === 'walk') {
      expect(Math.hypot(cat.lx - x0, cat.ly - y0)).toBeCloseTo(CAT_SPEED * 0.1, 0);
    }
  });
});
