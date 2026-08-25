import { describe, expect, it } from 'vitest';
import {
  createReceptionist,
  RECEPTIONIST_SLEEP_DELAY_S,
  RECEPTIONIST_WAKE_S,
  stepReceptionist,
} from './receptionist';

/**
 * A simulated viewer: one receptionist state stepped the way the scene loop does, carrying the
 * wall clock her work beats key off (E1 spec §2 — the draws are shared, the state machine local).
 */
function viewer(team = 'revive', startMs = 0) {
  const r = createReceptionist();
  let nowMs = startMs;
  const step = (seconds: number, present: boolean, greeting = false): boolean => {
    let active = false;
    for (let t = 0; t < seconds - 1e-9; t += 0.05) {
      nowMs += 50;
      active = stepReceptionist(r, 0.05, present, greeting, { team, nowMs });
    }
    return active;
  };
  return { r, step };
}

describe('the receptionist', () => {
  it('is asleep when nobody is in, and asleep does not keep the frame loop alive', () => {
    const v = viewer();
    expect(v.r.mode).toBe('asleep');
    expect(v.step(5, false)).toBe(false);
  });

  it('does not hold a quiet room off its baked frame just to sway', () => {
    const v = viewer();
    v.step(RECEPTIONIST_WAKE_S + 0.5, true);
    expect(v.r.mode).toBe('idle');
    // One tick that stays in idle must not claim the dynamic frame. Asserted per-tick rather than
    // over a window: work beats fire on a jittered wall-clock lattice, so any window long enough
    // to be interesting is also long enough to start typing — which SHOULD hold the frame.
    const active = v.step(0.05, true);
    if (v.r.mode === 'idle') expect(active).toBe(false);
  });

  it('wakes on the first arrival and stays awake while anyone is present', () => {
    const v = viewer();
    v.step(RECEPTIONIST_WAKE_S + 0.2, true);
    expect(v.r.mode).toBe('idle');
    v.step(30, true);
    expect(v.r.mode).not.toBe('asleep'); // idle or mid-beat — never back under
  });

  it('works: over a few minutes she both types and takes a call', () => {
    const v = viewer();
    const seen = new Set<string>();
    for (let i = 0; i < 6000; i++) {
      v.step(0.05, true);
      seen.add(v.r.mode);
    }
    expect(seen.has('typing')).toBe(true);
    expect(seen.has('call')).toBe(true);
    expect(seen.has('idle')).toBe(true); // beats are punctuation, not a treadmill
  });

  it('drops whatever she is doing to greet somebody at the counter', () => {
    const v = viewer();
    // Wind her into a work beat, then put a member at the mark.
    for (let i = 0; i < 4000 && !['typing', 'call'].includes(v.r.mode); i++) {
      v.step(0.05, true);
    }
    expect(['typing', 'call']).toContain(v.r.mode);
    v.step(0.05, true, true);
    expect(v.r.mode).toBe('greeting');
  });

  it('does not keep typing at an office that just emptied', () => {
    const v = viewer();
    for (let i = 0; i < 4000 && v.r.mode !== 'typing'; i++) v.step(0.05, true);
    expect(v.r.mode).toBe('typing');
    v.step(0.05, false);
    expect(v.r.mode).toBe('idle');
  });

  it('goes back to sleep a beat after the last member leaves — never instantly', () => {
    const v = viewer();
    v.step(2, true);
    v.step(RECEPTIONIST_SLEEP_DELAY_S / 2, false);
    expect(v.r.mode).not.toBe('asleep'); // still up, straightening the visitor log
    v.step(RECEPTIONIST_SLEEP_DELAY_S, false);
    expect(v.r.mode).toBe('asleep');
  });

  it('looks up for a check-in and returns to idle when the beat ends', () => {
    const v = viewer();
    v.step(2, true);
    v.step(0.1, true, true);
    expect(v.r.mode).toBe('greeting');
    v.step(0.1, true, false);
    expect(v.r.mode).toBe('idle');
  });

  it('a wave of arrivals into an empty office wakes her INTO the greeting', () => {
    const v = viewer();
    v.step(RECEPTIONIST_WAKE_S + 0.1, true, true);
    expect(v.r.mode).toBe('greeting');
  });
});

describe('shared work beats (E1 spec §2)', () => {
  /** Step one viewer for `seconds` and log every mode transition as [second, mode, beatLen]. */
  function transitions(v: ReturnType<typeof viewer>, seconds: number): Array<[number, string, number]> {
    const log: Array<[number, string, number]> = [];
    let last = v.r.mode;
    for (let t = 0; t < seconds; t += 0.05) {
      v.step(0.05, true);
      if (v.r.mode !== last) {
        log.push([Math.round(t * 20) / 20, v.r.mode, v.r.beatLen]);
        last = v.r.mode;
      }
    }
    return log;
  }

  it('two viewers over the same wall clock draw identical beats — kind, length, and timing', () => {
    const a = transitions(viewer('revive'), 180);
    const b = transitions(viewer('revive'), 180);
    expect(a.length).toBeGreaterThan(4); // she actually worked
    expect(a).toEqual(b);
  });

  it('different teams see different desks', () => {
    const a = transitions(viewer('revive'), 180);
    const b = transitions(viewer('other-team'), 180);
    expect(a).not.toEqual(b);
  });

  it('a viewer that joins late converges onto the same beat schedule', () => {
    const early = viewer('revive', 0);
    const lateStart = 60_000;
    const late = viewer('revive', lateStart);
    const a = transitions(early, 180); // 0..180s of wall time
    const b = transitions(late, 120); // 60..180s of the same wall time
    // Compare the overlap, past one full beat of settling: every transition the late viewer makes
    // after its first 30 s must appear in the early viewer's log at the same wall second.
    const settled = b.filter(([t]) => t >= 30).map(([t, m, l]) => [t + lateStart / 1000, m, l]);
    const inEarly = new Set(a.map(([t, m, l]) => `${t}|${m}|${l}`));
    for (const [t, m, l] of settled) expect(inEarly.has(`${t}|${m}|${l}`)).toBe(true);
  });
});
