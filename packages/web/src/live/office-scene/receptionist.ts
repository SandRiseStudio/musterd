// The office receptionist — staff, not roster.
//
// Every avatar on the floor is attested: a real seat, a real harness, a real model (ADR 101/109).
// The receptionist has nothing to attest, so she must never look like a member: no nameplate, no
// headcount, no roster row, and she never leaves the desk. She is set dressing that breathes, in
// the same category as the dog — which is why this module follows pet.ts's shape (a plain state
// object stepped by the scene loop) rather than joining the actor engine, where anonymous entries
// in the member map are exactly the confusion the room exists to prevent.

/**
 * Her day. `asleep` is the empty office's state — slumped over the desk, deliberately STILL, because
 * an empty office must not spend frame budget on a character nobody is watching. She wakes on the
 * first arrival, works small idles while anyone is present, looks up (`greeting`) while a check-in
 * beat plays, and dozes off again a little after the last member leaves.
 */
export type ReceptionistMode = 'asleep' | 'waking' | 'idle' | 'greeting' | 'typing' | 'call';

export interface ReceptionistState {
  mode: ReceptionistMode;
  /** Seconds in the current mode. */
  modeT: number;
  /** Seconds since the office emptied — the fuse on going back to sleep. */
  aloneT: number;
  /** Seconds until the next work beat is drawn. */
  nextBeat: number;
  /** How long the current beat runs. */
  beatLen: number;
}

/** How long a beat runs, seconds: a call is a conversation, typing is a burst. */
const BEAT_LEN: Record<'typing' | 'call', [number, number]> = {
  typing: [3, 7],
  call: [7, 14],
};
/** Gap between work beats. Wide and jittered — a receptionist on a metronome is a clock. */
const BEAT_GAP: [number, number] = [4, 11];

function reBeat(r: ReceptionistState): void {
  r.nextBeat = BEAT_GAP[0] + Math.random() * (BEAT_GAP[1] - BEAT_GAP[0]);
}

/** The wake stretch: the yawn-and-straighten between slumped and working. */
export const RECEPTIONIST_WAKE_S = 0.9;

/**
 * How long an empty office stays awake before she dozes off. Not instant, on purpose: a receptionist
 * who snaps back to slumped the frame the last member leaves reads as a bug, not as the joke.
 */
export const RECEPTIONIST_SLEEP_DELAY_S = 6;

export function createReceptionist(): ReceptionistState {
  const r: ReceptionistState = { mode: 'asleep', modeT: 0, aloneT: 0, nextBeat: 0, beatLen: 0 };
  reBeat(r);
  return r;
}

/** Is she mid-work-beat? The painter uses this to pick the pose; nothing else should care. */
export function receptionistBusy(r: ReceptionistState): boolean {
  return r.mode === 'typing' || r.mode === 'call';
}

/**
 * Advance her state. Returns whether she needs the dynamic frame — true only while she is actually
 * MOVING (waking, greeting, or the single step of any mode flip, so the baked buffer refreshes with
 * her new pose). Plain `idle` returns false on purpose: a subtle sway is not worth holding a quiet
 * room off its baked frame forever, which is the idle-cost rule the office loop is built around —
 * when the room is alive for other reasons she sways anyway, because the dynamic pass draws her too.
 */
export function stepReceptionist(
  r: ReceptionistState,
  dt: number,
  anyonePresent: boolean,
  greeting: boolean,
): boolean {
  const before = r.mode;
  r.modeT += dt;
  r.aloneT = anyonePresent ? 0 : r.aloneT + dt;

  switch (r.mode) {
    case 'asleep':
      if (anyonePresent) {
        r.mode = 'waking';
        r.modeT = 0;
      }
      break;
    case 'waking':
      if (r.modeT >= RECEPTIONIST_WAKE_S) {
        r.mode = greeting ? 'greeting' : 'idle';
        r.modeT = 0;
      }
      break;
    case 'idle':
      if (!anyonePresent && r.aloneT >= RECEPTIONIST_SLEEP_DELAY_S) {
        r.mode = 'asleep';
        r.modeT = 0;
      } else if (greeting) {
        r.mode = 'greeting';
        r.modeT = 0;
      } else {
        // Work beats: a stretch of typing, or a call on the corded landline. Drawn on a jittered
        // timer rather than alternating, so the desk never falls into a visible rhythm.
        r.nextBeat -= dt;
        if (r.nextBeat <= 0) {
          const kind = Math.random() < 0.55 ? 'typing' : 'call';
          const [lo, hi] = BEAT_LEN[kind];
          r.beatLen = lo + Math.random() * (hi - lo);
          r.mode = kind;
          r.modeT = 0;
        }
      }
      break;
    case 'typing':
    case 'call':
      // A greeting always wins: somebody is standing at the counter, and the whole point of the beat
      // is that she looks up. The interrupted call simply ends — she was wrapping up anyway.
      if (greeting) {
        r.mode = 'greeting';
        r.modeT = 0;
        reBeat(r);
      } else if (r.modeT >= r.beatLen || !anyonePresent) {
        r.mode = 'idle';
        r.modeT = 0;
        reBeat(r);
      }
      break;
    case 'greeting':
      if (!greeting) {
        r.mode = 'idle';
        r.modeT = 0;
      }
      break;
  }
  // Typing and calls are motion, so they hold the dynamic frame; settled idle does not (see above).
  return r.mode !== before || r.mode === 'waking' || r.mode === 'greeting' || receptionistBusy(r);
}
