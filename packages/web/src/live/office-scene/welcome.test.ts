import { describe, expect, it } from 'vitest';
import {
  createWelcome,
  WELCOME_BEATS,
  WELCOME_BEAT_GAP_MS,
  WELCOME_INTERVAL_MS,
  stepWelcome,
} from './welcome';

/** In-memory storage double; `null` models a browser where the accessor itself throws. */
function mem(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
}

describe('the receptionist welcome (first-five-seconds §4)', () => {
  it('is three beats, honest and warm — the copy sloane reviews is this constant', () => {
    expect(WELCOME_BEATS).toEqual([
      'welcome to the office',
      'everyone here is a real agent or human on one team, working right now',
      'the bubbles are their actual messages',
    ]);
  });

  it('/live: plays once on arrival, then remembers the visitor', () => {
    const store = mem();
    const w = createWelcome(false, store);
    expect(stepWelcome(w, 1000, false)).toBe(WELCOME_BEATS[0]);
    expect(stepWelcome(w, 1000 + WELCOME_BEAT_GAP_MS, false)).toBe(WELCOME_BEATS[1]);
    expect(stepWelcome(w, 1000 + 2 * WELCOME_BEAT_GAP_MS, false)).toBe(WELCOME_BEATS[2]);
    expect(stepWelcome(w, 1000 + 3 * WELCOME_BEAT_GAP_MS, false)).toBeNull();
    // A returning viewer is not re-greeted.
    const again = createWelcome(false, store);
    expect(stepWelcome(again, 99_000, false)).toBeNull();
  });

  it('/live: a browser without storage degrades to greeting again, never to crashing', () => {
    const throwing = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const w = createWelcome(false, throwing);
    expect(stepWelcome(w, 1000, false)).toBe(WELCOME_BEATS[0]);
  });

  it('/broadcast: replays every ~20 minutes, as if greeting the stream', () => {
    const w = createWelcome(true, mem());
    expect(stepWelcome(w, 0, false)).toBe(WELCOME_BEATS[0]);
    stepWelcome(w, WELCOME_BEAT_GAP_MS, false);
    stepWelcome(w, 2 * WELCOME_BEAT_GAP_MS, false);
    // Sequence over; nothing until the interval elapses.
    expect(stepWelcome(w, 10 * 60_000, false)).toBeNull();
    expect(stepWelcome(w, WELCOME_INTERVAL_MS + 60_000, false)).toBe(WELCOME_BEATS[0]);
  });

  it('yields to real choreography — a busy room delays the start, never a mid-sequence beat', () => {
    const w = createWelcome(true, mem());
    expect(stepWelcome(w, 0, true)).toBeNull(); // busy: the welcome waits
    expect(stepWelcome(w, 30_000, false)).toBe(WELCOME_BEATS[0]);
    // Once started, beats keep coming even if the room gets busy — stopping mid-thought reads worse.
    expect(stepWelcome(w, 30_000 + WELCOME_BEAT_GAP_MS, true)).toBe(WELCOME_BEATS[1]);
  });
});
