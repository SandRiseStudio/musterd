// The office receptionist — staff, not roster.
//
// Every avatar on the floor is attested: a real seat, a real harness, a real model (ADR 101/109).
// The receptionist has nothing to attest, so she must never look like a member: no nameplate, no
// headcount, no roster row, and she never leaves the desk. She is set dressing that breathes, in
// the same category as the dog — which is why this module follows pet.ts's shape (a plain state
// object stepped by the scene loop) rather than joining the actor engine, where anonymous entries
// in the member map are exactly the confusion the room exists to prevent.

import { roll } from './ambientSeed';

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
  /** The last wall-clock beat slot considered — each slot draws at most once. */
  lastSlot: number;
  /** How long the current beat runs. */
  beatLen: number;
}

/** How long a beat runs, seconds: a call is a conversation, typing is a burst. */
const BEAT_LEN: Record<'typing' | 'call', [number, number]> = {
  typing: [3, 7],
  call: [7, 14],
};
/**
 * Her work beats key off a wall-clock lattice shared by every viewer (E1 spec §2): each 5 s slot
 * she spends idle fires a beat with p = 2/3 — the same one-beat-per-~7.5-idle-seconds the old
 * jittered [4, 11] s countdown averaged, but drawn from `roll(team, slot, …)` so two browsers
 * watching the same team see her pick up the same phone at the same moment. The probability IS the
 * jitter — a receptionist on a metronome is a clock, and a coin flipped per slot is not one.
 */
export const RECEPTION_SLOT_MS = 5_000;
const RECEPTION_FIRE_P = 2 / 3;

/** The wake stretch: the yawn-and-straighten between slumped and working. */
export const RECEPTIONIST_WAKE_S = 0.9;

/**
 * How long an empty office stays awake before she dozes off. Not instant, on purpose: a receptionist
 * who snaps back to slumped the frame the last member leaves reads as a bug, not as the joke.
 */
export const RECEPTIONIST_SLEEP_DELAY_S = 6;

export function createReceptionist(): ReceptionistState {
  return { mode: 'asleep', modeT: 0, aloneT: 0, lastSlot: -1, beatLen: 0 };
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
  seed: { team: string; nowMs: number },
): boolean {
  const before = r.mode;
  const slot = Math.floor(seed.nowMs / RECEPTION_SLOT_MS);
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
        r.lastSlot = slot; // the slot underway as she settles in is spent — no late-started beats
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
        // Work beats: a stretch of typing, or a call on the corded landline. Drawn once per shared
        // wall-clock slot — every viewer computes the same draw, so they see the same beat. A slot
        // already underway when she reaches idle is skipped (`lastSlot` on entry): starting it late
        // would put this viewer's beat out of phase with everyone who started it on time.
        if (slot !== r.lastSlot) {
          r.lastSlot = slot;
          if (roll(seed.team, slot, 'reception-fire') < RECEPTION_FIRE_P) {
            const kind = roll(seed.team, slot, 'reception-kind') < 0.55 ? 'typing' : 'call';
            const [lo, hi] = BEAT_LEN[kind];
            r.beatLen = lo + roll(seed.team, slot, 'reception-len') * (hi - lo);
            r.mode = kind;
            r.modeT = 0;
          }
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
        r.lastSlot = slot;
      } else if (r.modeT >= r.beatLen || !anyonePresent) {
        // The slot she lands back in is spent — beats stay punctuation, never back-to-back. Both
        // viewers finish at the same wall time (same start, same beatLen), so this stays shared.
        r.mode = 'idle';
        r.modeT = 0;
        r.lastSlot = slot;
      }
      break;
    case 'greeting':
      if (!greeting) {
        r.mode = 'idle';
        r.modeT = 0;
        r.lastSlot = slot; // greetings are local (this viewer's check-in beat) — resync, don't backfill
      }
      break;
  }
  // Typing and calls are motion, so they hold the dynamic frame; settled idle does not (see above).
  return r.mode !== before || r.mode === 'waking' || r.mode === 'greeting' || receptionistBusy(r);
}
