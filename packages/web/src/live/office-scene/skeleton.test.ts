import { describe, expect, it } from 'vitest';
import { DESK_UP, SEAT_TOP } from './layout';
import { CHAR, DESK_REACH, seedOf, solveSkeleton, STRIDE, typingBurst, type SkelInput } from './skeleton';

/**
 * The character rig's contract. These are the properties that make the office read as *people* rather than
 * as sliding clip art — each one is a bug we can't see in a screenshot but would feel instantly on screen.
 */

const base: SkelInput = {
  phase: 0,
  sit: 0,
  stride: 0,
  run: false,
  t: 0,
  typing: 0,
  carry: false,
  help: false,
  gesture: 0,
  gestureT: 0,
  seed: 0.5,
};
const walk = (phase: number, o: Partial<SkelInput> = {}): SkelInput => ({ ...base, phase, stride: 1, ...o });
const sit = (o: Partial<SkelInput> = {}): SkelInput => ({ ...base, sit: 1, ...o });

describe('walk cycle', () => {
  it('swings the legs — the feet are in different places through the stride', () => {
    const a = solveSkeleton(walk(0));
    const b = solveSkeleton(walk(0.5));
    expect(Math.abs(a.ankle[1].z - b.ankle[1].z)).toBeGreaterThan(10);
  });

  it('swings the arms, and counter to the legs — the tell that separates walking from gliding', () => {
    // Sample the *extremes* of the swing (phase 0 / 0.5). Phases 0.25 and 0.75 are the zero-crossings,
    // where a perfectly good arm swing reads as no swing at all.
    const s = solveSkeleton(walk(0));
    // right leg forward ⇒ right arm back, and vice versa
    expect(Math.sign(s.ankle[1].z - s.ankle[0].z)).toBe(-Math.sign(s.wrist[1].z - s.wrist[0].z));
    const t = solveSkeleton(walk(0.5));
    expect(Math.abs(s.wrist[1].z - t.wrist[1].z)).toBeGreaterThan(8);
  });

  it('never puts a foot through the floor, at any phase', () => {
    for (let i = 0; i < 64; i++) {
      const s = solveSkeleton(walk(i / 64, { run: true }));
      for (const a of s.ankle) expect(a.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('lifts each foot exactly once per stride — a plant, then a swing', () => {
    const lifted = (phase: number) => solveSkeleton(walk(phase)).ankle[1].y > CHAR.ankle + 1;
    let flips = 0;
    for (let i = 1; i <= 64; i++) if (lifted(i / 64) !== lifted((i - 1) / 64)) flips++;
    expect(flips).toBe(2); // exactly one contiguous airborne window per cycle
  });

  it('is continuous across the phase wrap — no hitch as the cycle repeats', () => {
    const a = solveSkeleton(walk(0.999));
    const b = solveSkeleton(walk(0));
    expect(Math.abs(a.ankle[1].z - b.ankle[1].z)).toBeLessThan(1);
  });

  it('runs bigger than it walks — longer reach, higher lift, deeper lean', () => {
    const w = solveSkeleton(walk(0.25));
    const r = solveSkeleton(walk(0.25, { run: true }));
    expect(Math.abs(r.ankle[1].z)).toBeGreaterThan(Math.abs(w.ankle[1].z));
    expect(r.lean).toBeGreaterThan(w.lean);
  });

  it('settles out of the stride continuously — a half-expressed stride is between idle and walking', () => {
    const idle = solveSkeleton({ ...base, phase: 0.25 });
    const full = solveSkeleton(walk(0.25));
    const half = solveSkeleton({ ...base, phase: 0.25, stride: 0.5 });
    const lo = Math.min(idle.ankle[1].z, full.ankle[1].z);
    const hi = Math.max(idle.ankle[1].z, full.ankle[1].z);
    expect(half.ankle[1].z).toBeGreaterThanOrEqual(lo);
    expect(half.ankle[1].z).toBeLessThanOrEqual(hi);
  });
});

describe('seated', () => {
  it('puts the pelvis on the chair cushion, not on the floor', () => {
    const s = solveSkeleton(sit());
    expect(s.pelvis.y).toBeGreaterThanOrEqual(SEAT_TOP);
    expect(s.pelvis.y).toBeLessThan(SEAT_TOP + 4);
  });

  it('keeps the feet on the floor and the knees forward of the hips', () => {
    const s = solveSkeleton(sit());
    for (const a of s.ankle) expect(a.y).toBeLessThan(8);
    for (const i of [0, 1] as const) expect(s.knee[i].z).toBeGreaterThan(s.hip[i].z + 8);
  });

  it('rests the hands on the desk surface, within reach — this is the whole "at the desk" read', () => {
    const s = solveSkeleton(sit());
    for (const w of s.wrist) {
      expect(w.y).toBeGreaterThan(DESK_UP); // on the surface, not through it
      expect(w.z).toBeGreaterThan(15); // reaching forward to the keys, not in their lap
    }
    // and the arm is long enough to actually get there — no rubber-band limb
    const reach = Math.hypot(
      s.wrist[1].x - s.shoulder[1].x,
      s.wrist[1].y - s.shoulder[1].y,
      s.wrist[1].z - s.shoulder[1].z,
    );
    expect(reach).toBeLessThanOrEqual(CHAR.upperArm + CHAR.foreArm);
  });

  it('clears the desk with the shoulders and head — the "only tops of their heads" bug', () => {
    const s = solveSkeleton(sit());
    // The desk's far edge is what occludes a member sitting behind it; the shoulders must clear the
    // surface, and the whole head must sit proudly above it.
    expect(s.shoulder[0].y).toBeGreaterThan(DESK_UP);
    expect(s.head.y - s.headR).toBeGreaterThan(DESK_UP + 8);
  });

  it('sits *down* — a half-blend is between standing and seated, never a teleport', () => {
    const stand = solveSkeleton(base);
    const seated = solveSkeleton(sit());
    const half = solveSkeleton({ ...base, sit: 0.5 });
    expect(half.pelvis.y).toBeLessThan(stand.pelvis.y);
    expect(half.pelvis.y).toBeGreaterThan(seated.pelvis.y);
  });
});

describe('typing', () => {
  it('moves the hands while typing', () => {
    const at = (t: number) => solveSkeleton(sit({ t, typing: 1 })).wrist[1].y;
    const ys = [0, 0.02, 0.04, 0.06, 0.08].map(at);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.5);
  });

  it('bursts rather than drumming forever — a member types, then pauses to think', () => {
    const seed = 0.3;
    const samples = Array.from({ length: 400 }, (_, i) => typingBurst(seed, i * 0.05));
    expect(Math.max(...samples)).toBeCloseTo(1, 1); // really types
    expect(samples.some((s) => s === 0)).toBe(true); // really stops
    const duty = samples.filter((s) => s > 0).length / samples.length;
    expect(duty).toBeGreaterThan(0.1);
    expect(duty).toBeLessThan(0.6); // pausing more than typing — it's punctuation, not a metronome
  });

  it('is seeded per member, so a room does not type in unison', () => {
    expect(typingBurst(0.1, 3)).not.toBe(typingBurst(0.8, 3));
  });
});

describe('rig invariants', () => {
  it('reaches the keyboard by construction — the desk and the arm agree on where the keys are', () => {
    expect(DESK_REACH.z).toBeLessThan(CHAR.upperArm + CHAR.foreArm);
    expect(DESK_REACH.y).toBeGreaterThan(DESK_UP);
  });

  it('hangs the arms outside the torso, so the far arm is never swallowed by the body', () => {
    expect(CHAR.shoulderW).toBeGreaterThan(12.5); // > TORSO_W/2 in character.ts
  });

  it('produces finite joints for every state it can be asked for', () => {
    const states: SkelInput[] = [
      base,
      walk(0.3),
      walk(0.7, { run: true, carry: true }),
      sit({ typing: 1, t: 5 }),
      sit({ gesture: 1, gestureT: 0.5 }),
      sit({ gesture: 2, gestureT: 0.5 }),
      { ...base, help: true, t: 2 },
      { ...base, sit: 0.37, stride: 0.62, phase: 0.4 },
    ];
    for (const s of states) {
      const k = solveSkeleton(s);
      for (const j of [k.pelvis, k.chest, k.head, ...k.ankle, ...k.wrist, ...k.knee, ...k.elbow]) {
        expect(Number.isFinite(j.x) && Number.isFinite(j.y) && Number.isFinite(j.z)).toBe(true);
      }
    }
  });

  it('seeds deterministically per name — a member looks the same across reloads', () => {
    expect(seedOf('miley')).toBe(seedOf('miley'));
    expect(seedOf('miley')).not.toBe(seedOf('izzo'));
  });

  it('has a stride long enough to be a step, not a shuffle', () => {
    expect(STRIDE).toBeGreaterThan(CHAR.thigh);
  });
});
