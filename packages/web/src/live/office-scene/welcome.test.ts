import { describe, expect, it } from 'vitest';
import {
  createWelcome,
  welcomeBeats,
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
      'welcome to the musterd office — team {team} is on the floor',
      'everyone here is a real agent or human on one team, working right now',
      'the bubbles are their actual messages',
    ]);
  });

  /* Beat one names the product and the team (nick, 2026-09-02). It used to be "welcome to the
     office" — the one line in the sequence a stranger could have read anywhere, saying neither
     where they had landed nor whose room this is. */
  it('names the team in the first beat', () => {
    expect(welcomeBeats('revive')[0]).toBe(
      'welcome to the musterd office — team revive is on the floor',
    );
  });

  /* A greeting is the worst place in the product to leak a template. Every surface that mounts the
     scene without team data reaches this — and so does a team whose name is whitespace. */
  it('never greets anyone with a placeholder or a gap', () => {
    for (const bad of [undefined, null, '', '   ']) {
      const first = welcomeBeats(bad)[0]!;
      expect(first, JSON.stringify(bad)).toBe('welcome to the musterd office');
      expect(first).not.toContain('{team}');
    }
  });

  it('leaves the beats that say nothing about the team alone', () => {
    expect(welcomeBeats('revive').slice(1)).toEqual(WELCOME_BEATS.slice(1));
  });

  it('/live: plays once on arrival, then remembers the visitor', () => {
    const store = mem();
    const w = createWelcome(false, store);
    expect(stepWelcome(w, 1000, false, 'revive')).toBe(welcomeBeats('revive')[0]);
    expect(stepWelcome(w, 1000 + WELCOME_BEAT_GAP_MS, false, 'revive')).toBe(WELCOME_BEATS[1]);
    expect(stepWelcome(w, 1000 + 2 * WELCOME_BEAT_GAP_MS, false, 'revive')).toBe(WELCOME_BEATS[2]);
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
    expect(stepWelcome(w, 1000, false, 'revive')).toBe(welcomeBeats('revive')[0]);
  });

  it('/broadcast: replays every ~20 minutes, as if greeting the stream', () => {
    const w = createWelcome(true, mem());
    expect(stepWelcome(w, 0, false, 'revive')).toBe(welcomeBeats('revive')[0]);
    stepWelcome(w, WELCOME_BEAT_GAP_MS, false);
    stepWelcome(w, 2 * WELCOME_BEAT_GAP_MS, false);
    // Sequence over; nothing until the interval elapses.
    expect(stepWelcome(w, 10 * 60_000, false)).toBeNull();
    expect(stepWelcome(w, WELCOME_INTERVAL_MS + 60_000, false, 'revive')).toBe(
      welcomeBeats('revive')[0],
    );
  });

  it('yields to real choreography — a busy room delays the start, never a mid-sequence beat', () => {
    const w = createWelcome(true, mem());
    expect(stepWelcome(w, 0, true)).toBeNull(); // busy: the welcome waits
    expect(stepWelcome(w, 30_000, false, 'revive')).toBe(welcomeBeats('revive')[0]);
    // Once started, beats keep coming even if the room gets busy — stopping mid-thought reads worse.
    expect(stepWelcome(w, 30_000 + WELCOME_BEAT_GAP_MS, true, 'revive')).toBe(WELCOME_BEATS[1]);
  });
});
