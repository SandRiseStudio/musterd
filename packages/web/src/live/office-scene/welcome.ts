/**
 * The receptionist welcome (first-five-seconds spec §4) — the one place a full explanation is
 * allowed, delivered by the character whose job it is. Three beats, honest and warm; the realness
 * claim is stated explicitly because credibility is half the delight goal.
 *
 * Pure state machine: the scene calls {@link stepWelcome} from its existing loop and speaks
 * whatever beat comes back. `/live` plays once per visitor (storage-remembered; a browser that
 * blocks storage degrades to greeting again, never to crashing). `/broadcast` replays every
 * ~20 minutes, as if greeting the stream — a mid-stream stranger is at most one interval from the
 * full answer, and the caption rail carries them until then.
 */

/** The copy is brand voice on a public surface — sloane reviews changes to this constant. */
export const WELCOME_BEATS = [
  'welcome to the office',
  'everyone here is a real agent or human on one team, working right now',
  'the bubbles are their actual messages',
] as const;

export const WELCOME_BEAT_GAP_MS = 4_500;
export const WELCOME_INTERVAL_MS = 20 * 60_000;
const REMEMBER_KEY = 'lc-welcomed';

export interface WelcomeState {
  /** Next beat index; length = sequence finished. */
  beat: number;
  /** When the next beat (or the next sequence) may play; 0 = as soon as the room is quiet. */
  dueAt: number;
  /** Done for good (/live, already greeted or finished). */
  spent: boolean;
  broadcast: boolean;
  storage: Storage | null;
}

export function createWelcome(broadcast: boolean, storage: Storage | null): WelcomeState {
  let spent = false;
  if (!broadcast) {
    try {
      spent = storage?.getItem(REMEMBER_KEY) === '1';
    } catch {
      spent = false; // no storage → greet again, never crash
    }
  }
  return { beat: 0, dueAt: 0, spent, broadcast, storage };
}

/**
 * Advance the welcome. Returns the beat to speak now, or null. `busy` (real choreography playing)
 * delays the START of a sequence — once begun, beats keep coming; stopping mid-thought reads worse
 * than talking over a walk.
 */
export function stepWelcome(w: WelcomeState, now: number, busy: boolean): string | null {
  if (w.spent || now < w.dueAt) return null;
  if (w.beat === 0 && busy) return null; // yield: retry on a later step, no state burned
  const line = WELCOME_BEATS[w.beat];
  if (line === undefined) return null;
  w.beat += 1;
  if (w.beat >= WELCOME_BEATS.length) {
    if (w.broadcast) {
      w.beat = 0;
      w.dueAt = now + WELCOME_INTERVAL_MS;
    } else {
      w.spent = true;
      try {
        w.storage?.setItem(REMEMBER_KEY, '1');
      } catch {
        /* storage blocked — they may be greeted again next visit; harmless */
      }
    }
  } else {
    w.dueAt = now + WELCOME_BEAT_GAP_MS;
  }
  return line;
}
