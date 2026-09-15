// The room's audio LOGIC — which event fires under what gate, from which desk, at what tempo.
//
// Split from `sound.ts` deliberately (E2): everything here is consumed only by the lazily loaded
// `soundEngine.ts` chunk and by tests, so it must not sit on /live's eager graph. `sound.ts` keeps
// what a viewer needs before any sound plays (preferences, the `LifeContext` contract, the façades);
// this file is the roll, the keyboard, the think/type phase and the tempo — pure, deterministic in
// their inputs, and testable without an AudioContext.

import type { LifeContext } from './sound';

/**
 * Minimum gap between broadcast act cues, ms. The stream fires the whole team's acts at one
 * listener who cannot mute them, and the cue set was tuned for a person at a desk with sparse
 * arrivals — unthrottled, a busy minute is a slot machine.
 *
 * A dropped cue plays nothing later: the visual channel (speech bubble, stream panel) already
 * carries every act, so the audio does not owe the viewer completeness.
 */
const BROADCAST_CUE_GAP_MS = 700;

/** Pure gate for the broadcast cue throttle — a burst coalesces to one cue rather than queueing. */
export function shouldChime(now: number, last: number, minGapMs = BROADCAST_CUE_GAP_MS): boolean {
  return now - last >= minGapMs;
}

// ── the life roll, as data ───────────────────────────────────────────────────────────────────────
//
// Which small noise plays next used to be an inline `if (roll < 0.34) …` chain, which nothing could
// test and every addition re-balanced by hand. It is now a weighted table plus a pure picker, so the
// mix is inspectable, the gates (chatter needs two people NEAR each other, dog noises need the dog)
// are testable without an AudioContext, and the synths below stay what they are: leaf functions.

/**
 * The mix. Work and talk stay the majority on purpose — the new events are seasoning, and a room
 * where the stapler fires as often as the typing is a cartoon. Weights sum to 1; the gated events'
 * weight is REDISTRIBUTED (by renormalising over what is available) when their condition fails, so
 * an empty office is not simply quieter by the chatter slots.
 *
 * ── TWO EVENTS ARE DELIBERATELY ABSENT, and adding either back is a regression ─────────────────
 *
 * `chime` and `creak` were removed on 2026-09-02 (nick). The rule they broke: **the room tone may
 * never make a noise a viewer could mistake for a musterd cue.** The bed says "the office is
 * inhabited"; the cues (`FirehoseSound.chime`, and the `askbell` moment) say "something arrived
 * for you". A viewer who cannot tell those apart has to check the room every time the room
 * breathes, which is the exact opposite of what ambience is for.
 *
 * · `chime` was a chat-app ping at a neighbouring desk — its own doc comment said so — built from
 *   two soft sine notes 90 ms apart in the 523–988 Hz band. `CUES` is *also* soft sine notes, two
 *   or three of them, 120 ms apart, in the 392–784 Hz band. They were the same instrument playing
 *   the same figure; nothing but volume separated "somebody else got a Slack message" from "an act
 *   landed for you". No weight tuning fixes that — the collision is in the synthesis.
 * · `creak` was a chair taking somebody's weight: a narrow (Q 7) noise band gliding 520 → 300 Hz
 *   over 0.42 s. That is the same downward sweep gesture as the `whoosh` moment, and at gain 0.16
 *   it was the loudest thing in the whole life table.
 *
 * The 0.08 they held went back to `keys` and `murmur` — the work-and-talk majority the mix is
 * built around — rather than being spread thin over the seasoning, which would have quietly made
 * the stapler and the drawer a third more common than they were ever tuned to be.
 */
export const LIFE_EVENTS: ReadonlyArray<{ name: string; weight: number }> = [
  { name: 'keys', weight: 0.39 },
  { name: 'murmur', weight: 0.2 },
  { name: 'whisper', weight: 0.04 },
  { name: 'tap', weight: 0.07 },
  { name: 'softTap', weight: 0.03 },
  { name: 'stapler', weight: 0.03 },
  { name: 'drawer', weight: 0.03 },
  { name: 'footsteps', weight: 0.03 },
  { name: 'sip', weight: 0.03 },
  { name: 'blow', weight: 0.01 },
  { name: 'water', weight: 0.02 },
  { name: 'eating', weight: 0.02 },
  { name: 'paws', weight: 0.025 },
  { name: 'jingle', weight: 0.01 },
  { name: 'yawn', weight: 0.01 },
  // A bark on a timer is an alarm clock. Rarity IS the design; do not "fix" this upward.
  { name: 'bark', weight: 0.005 },
  // The day cycle (E2 spec §4): both weight-modulated by the lighting envelope below.
  { name: 'birds', weight: 0.03 },
  { name: 'nightair', weight: 0.02 },
];

const CHATTER = new Set(['murmur', 'whisper']);
const DOG_EVENTS = new Set(['paws', 'jingle', 'yawn', 'bark']);
/** The "somebody is doing something" family — gated on evidenced work, placed at a working desk.
 *  (`creak` was one of these; see the removal note on LIFE_EVENTS.) */
const WORK_EVENTS = new Set(['keys', 'tap', 'softTap', 'drawer', 'stapler']);

// ── the think/type phase ─────────────────────────────────────────────────────────────────────────

/** The same avalanche hash the keyboard uses, so a desk's rhythm is as stable as its thock. */
function hashUnit(seed: number, salt: number): number {
  let h = Math.imul(seed ^ (salt * 0x9e3779b9), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Where a working desk is in its own think/type cycle. Bursts of keys, then a quieter stretch of
 * pen-taps and chair-creaks — a person, not a typing machine. Deterministic in `(seed, nowMs)` so
 * tests can hold it still; phase lengths are drawn per desk (typing 18–36s, thinking 12–28s) with a
 * per-desk offset so a floor of desks never types in unison.
 */
export function deskPhase(seed: number, nowMs: number): 'typing' | 'thinking' {
  const typeLen = 18 + hashUnit(seed, 1) * 18;
  const thinkLen = 12 + hashUnit(seed, 2) * 16;
  const cycle = typeLen + thinkLen;
  const pos = (nowMs / 1000 + hashUnit(seed, 3) * cycle) % cycle;
  return pos < typeLen ? 'typing' : 'thinking';
}

/** Desks eligible to carry `name` right now: keys need a desk actually typing; the quieter work
 *  sounds (a tap, a creak, a drawer) can come from any working desk — thought still shuffles paper. */
function workDesksFor(name: string, ctx: LifeContext, nowMs: number): ReadonlyArray<{ x: number; seed: number }> {
  if (name === 'keys') return ctx.working.filter((d) => deskPhase(d.seed, nowMs) === 'typing');
  return ctx.working;
}

/**
 * Which working desk a work-family event plays from, for a uniform `roll` in [0, 1). Null when no
 * desk may carry it — which is exactly when `pickLifeEvent` would not have picked it. The engine
 * pans to `x` and, for keys, builds the keyboard from `seed`, so each desk sounds like itself.
 */
export function pickWorkDesk(
  name: string,
  roll: number,
  ctx: LifeContext,
  nowMs: number,
): { x: number; seed: number } | null {
  const desks = workDesksFor(name, ctx, nowMs);
  if (desks.length === 0) return null;
  return desks[Math.min(desks.length - 1, Math.floor(roll * desks.length))]!;
}

/** Is this event available under the current occupancy? Chatter needs a co-located pair — a headcount
 *  of two at opposite ends of the floor is not a conversation. Paws need the dog actually walking.
 *  Work sounds need a desk that is evidenced-working (and keys, one actually typing). The day pair
 *  follows the lighting envelope: birds only into a morning with daylight, night air only for a dark
 *  room someone is actually in — the late shift, not a nature documentary over an empty office. */
function lifeAvailable(name: string, ctx: LifeContext, nowMs: number): boolean {
  if (WORK_EVENTS.has(name)) return workDesksFor(name, ctx, nowMs).length > 0;
  if (CHATTER.has(name)) return ctx.pairs.length > 0;
  if (name === 'paws') return ctx.dog?.walking === true;
  if (DOG_EVENTS.has(name)) return ctx.dog != null;
  if (name === 'birds') return ctx.hours >= 5 && ctx.hours < 11 && ctx.daylight > 0.15;
  if (name === 'nightair') {
    return ctx.daylight < 0.12 && (ctx.working.length > 0 || ctx.pairs.length > 0);
  }
  return true;
}

/** A busy room is busier, not louder: work-family weights rise modestly with density (up to +60%);
 *  presence sounds keep their weight. Gains are untouched — density is tempo and mix, never volume. */
function lifeWeight(e: { name: string; weight: number }, ctx: LifeContext): number {
  return WORK_EVENTS.has(e.name) ? e.weight * (1 + 0.6 * ctx.density) : e.weight;
}

/** Pick the next life event for a uniform `roll` in [0, 1). Pure and deterministic. */
export function pickLifeEvent(roll: number, ctx: LifeContext, nowMs = 0): string {
  const avail = LIFE_EVENTS.filter((e) => lifeAvailable(e.name, ctx, nowMs));
  const total = avail.reduce((sum, e) => sum + lifeWeight(e, ctx), 0);
  let acc = 0;
  for (const e of avail) {
    acc += lifeWeight(e, ctx);
    if (roll * total < acc) return e.name;
  }
  return avail[avail.length - 1]!.name;
}

// ── the bed's tempo ──────────────────────────────────────────────────────────────────────────────

/** Seconds between life events for a quiet-but-occupied room — the historical cadence. */
export const LIFE_GAP: [number, number] = [2.5, 8];

/**
 * The bed's tempo under load: a full sprint schedules life events about twice as often as a quiet
 * room, monotonically in `density`, and never below a floor that keeps a busy minute from becoming
 * a slot machine (the same principle as the broadcast chime throttle).
 */
export function lifeGapFor(density: number): [number, number] {
  const d = Math.max(0, Math.min(1, density));
  return [Math.max(1.2, LIFE_GAP[0] / (1 + d)), LIFE_GAP[1] / (1 + d)];
}

/**
 * Where an event pans. Chatter comes from the pair and dog noises from the dog — the room's sound
 * should match what the eye can see. Everything else returns null: play it from a random side, the
 * way the layer always has (everything in an office happens at somebody else's desk).
 */
export function panFor(name: string, ctx: LifeContext): number | null {
  if (CHATTER.has(name)) return (ctx.pairs[0]?.x ?? 0) * 0.75;
  if (DOG_EVENTS.has(name)) return (ctx.dog?.x ?? 0) * 0.75;
  return null;
}

// ── the keyboard ─────────────────────────────────────────────────────────────────────────────────

/** One desk's keyboard: the body pitch of its thock, the down→up gap, and the two transient gains. */
export interface Keyboard {
  body: number;
  gap: number;
  downGain: number;
  upGain: number;
}

/**
 * A keyboard per RUN, not per key. Every keystroke in the office used to be the same synth roll, so
 * a burst at one desk sounded identical to a burst at another; drawing the parameters once per run
 * makes a burst one keyboard and the next burst a different desk. Deterministic in the seed so the
 * tests can hold it still.
 */
export function keyboardFor(seed: number): Keyboard {
  const r = (salt: number): number => {
    let h = Math.imul(seed ^ (salt * 0x9e3779b9), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  return {
    // An octave-ish below the old 1650–2550 Hz band: the bright band was the "fake" half of the
    // complaint — it was playing only a keystroke's click, never its thock.
    body: 750 + r(1) * 550,
    gap: 0.028 + r(2) * 0.03,
    downGain: 0.017 + r(3) * 0.009,
    upGain: 0.01 + r(4) * 0.005,
  };
}

/**
 * The two transients of one keypress: a low thock as the key bottoms out, then a lighter, brighter
 * click as it releases. The original played only the second half, which is why it read as fake AND
 * as the loudest thing in the room — both complaints had the same root (nick, 2026-07-30).
 */
export function keypressPlan(kb: Keyboard): ReadonlyArray<{ freq: number; gain: number; dur: number; at: number }> {
  return [
    { freq: kb.body, gain: kb.downGain, dur: 0.045, at: 0 },
    { freq: kb.body * 2.6, gain: kb.upGain, dur: 0.028, at: kb.gap },
  ];
}

// ── milestone moments (E3) ───────────────────────────────────────────────────────────────────────

/** The room's placed reactions — diegetic, on the room-tone layer; NOT the firehose act cues.
 *  E3 gave the room its moments; E4 adds the viewer's own hand (plate, board, the directed whoosh). */
export type Moment =
  | 'fanfare'
  | 'door'
  | 'askbell'
  | 'plateOpen'
  | 'plateClose'
  | 'boardOpen'
  | 'boardClose'
  | 'whoosh';

/** Minimum gap between moments, ms. Moments are act-driven and sparse by nature; the one plausible
 *  burst (a flood of accepts) coalesces rather than becoming a slot machine — same principle as the
 *  broadcast cue throttle. */
const MOMENT_GAP_MS = 400;

/** Pure gate for the moment throttle — a burst plays once, the rest are dropped, never queued. */
export function shouldPlayMoment(now: number, last: number): boolean {
  return shouldChime(now, last, MOMENT_GAP_MS);
}

/** The engine's one squeeze: clamp, then ×0.75 — everything in an office happens off to one side. */
export function momentPan(pan: number): number {
  return Math.max(-1, Math.min(1, pan)) * 0.75;
}
