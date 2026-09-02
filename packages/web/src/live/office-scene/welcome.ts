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

/**
 * The copy is brand voice on a public surface — sloane reviews changes to this constant.
 *
 * Beat one names the product and the TEAM (nick, 2026-09-02). It was "welcome to the office", which
 * is the one sentence in the whole sequence a stranger could have read anywhere: it said neither
 * where they had landed nor whose room this is. The floor in front of them is a specific team's,
 * the roster rail already names it, and the receptionist is the character whose job is to say so.
 *
 * `{team}` is substituted by {@link welcomeBeats}, which is what every caller uses. The template
 * stays a constant so the copy is still reviewable as one block of text.
 */
export const WELCOME_BEATS = [
  'welcome to the musterd office — team {team} is on the floor',
  'everyone here is a real agent or human on one team, working right now',
  'the bubbles are their actual messages',
] as const;

/**
 * The beats for a given team. Falls back to a team-less first line rather than greeting anyone with
 * a literal `{team}` or an empty gap — the office preview and any surface that mounts the scene
 * without team data both reach this, and a greeting is the worst place to leak a placeholder.
 */
export function welcomeBeats(teamName?: string | null): string[] {
  const team = teamName?.trim();
  return WELCOME_BEATS.map((line) =>
    line.includes('{team}')
      ? team
        ? line.replace('{team}', team)
        : 'welcome to the musterd office'
      : line,
  );
}

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
export function stepWelcome(
  w: WelcomeState,
  now: number,
  busy: boolean,
  teamName?: string | null,
): string | null {
  if (w.spent || now < w.dueAt) return null;
  if (w.beat === 0 && busy) return null; // yield: retry on a later step, no state burned
  const line = welcomeBeats(teamName)[w.beat];
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
