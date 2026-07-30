import { describe, expect, it } from 'vitest';
import {
  createReceptionist,
  RECEPTIONIST_SLEEP_DELAY_S,
  RECEPTIONIST_WAKE_S,
  stepReceptionist,
} from './receptionist';

/** Step in small ticks, the way the scene loop does. */
function advance(
  r: ReturnType<typeof createReceptionist>,
  seconds: number,
  present: boolean,
  greeting = false,
): boolean {
  let active = false;
  for (let t = 0; t < seconds; t += 0.05) active = stepReceptionist(r, 0.05, present, greeting);
  return active;
}

describe('the receptionist', () => {
  it('is asleep when nobody is in, and asleep does not keep the frame loop alive', () => {
    const r = createReceptionist();
    expect(r.mode).toBe('asleep');
    expect(advance(r, 5, false)).toBe(false);
  });

  it('does not hold a quiet room off its baked frame just to sway', () => {
    const r = createReceptionist();
    advance(r, RECEPTIONIST_WAKE_S + 0.5, true);
    expect(r.mode).toBe('idle');
    expect(advance(r, 5, true)).toBe(false); // settled idle: the baked buffer can carry her
  });

  it('wakes on the first arrival and stays awake while anyone is present', () => {
    const r = createReceptionist();
    advance(r, RECEPTIONIST_WAKE_S + 0.2, true);
    expect(r.mode).toBe('idle');
    advance(r, 30, true);
    expect(r.mode).not.toBe('asleep'); // idle or mid-beat — never back under
  });

  it('works: over a few minutes she both types and takes a call', () => {
    const r = createReceptionist();
    const seen = new Set<string>();
    for (let i = 0; i < 6000; i++) {
      stepReceptionist(r, 0.05, true, false);
      seen.add(r.mode);
    }
    expect(seen.has('typing')).toBe(true);
    expect(seen.has('call')).toBe(true);
    expect(seen.has('idle')).toBe(true); // beats are punctuation, not a treadmill
  });

  it('drops whatever she is doing to greet somebody at the counter', () => {
    const r = createReceptionist();
    // Wind her into a work beat, then put a member at the mark.
    for (let i = 0; i < 4000 && !['typing', 'call'].includes(r.mode); i++) {
      stepReceptionist(r, 0.05, true, false);
    }
    expect(['typing', 'call']).toContain(r.mode);
    stepReceptionist(r, 0.05, true, true);
    expect(r.mode).toBe('greeting');
  });

  it('does not keep typing at an office that just emptied', () => {
    const r = createReceptionist();
    for (let i = 0; i < 4000 && r.mode !== 'typing'; i++) stepReceptionist(r, 0.05, true, false);
    expect(r.mode).toBe('typing');
    stepReceptionist(r, 0.05, false, false);
    expect(r.mode).toBe('idle');
  });

  it('goes back to sleep a beat after the last member leaves — never instantly', () => {
    const r = createReceptionist();
    advance(r, 2, true);
    advance(r, RECEPTIONIST_SLEEP_DELAY_S / 2, false);
    expect(r.mode).not.toBe('asleep'); // still up, straightening the visitor log
    advance(r, RECEPTIONIST_SLEEP_DELAY_S, false);
    expect(r.mode).toBe('asleep');
  });

  it('looks up for a check-in and returns to idle when the beat ends', () => {
    const r = createReceptionist();
    advance(r, 2, true);
    advance(r, 0.1, true, true);
    expect(r.mode).toBe('greeting');
    advance(r, 0.1, true, false);
    expect(r.mode).toBe('idle');
  });

  it('a wave of arrivals into an empty office wakes her INTO the greeting', () => {
    const r = createReceptionist();
    advance(r, RECEPTIONIST_WAKE_S + 0.1, true, true);
    expect(r.mode).toBe('greeting');
  });
});
