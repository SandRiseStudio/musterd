// Live sound, viewer-facing half — the preferences, the pure logic, and two façades that stand in
// for engines which may not be downloaded yet.
//
// **Why this file is split from `soundEngine.ts`.** The synths are the single biggest thing on /live
// that a viewer never needs: sound is opt-in, defaults OFF, and cannot legally start before a user
// gesture anyway. Carrying it in the eager graph spent the initial-JS budget (packages/web/AGENTS.md)
// on code most sessions never run. So the engines live behind `import('./soundEngine')`, fired from
// the click that turns sound on — the first moment the browser would have let them make a noise.
//
// What stays here is what a viewer DOES need before that click:
//
//   1. The stored preferences, so a toggle can render in the right position on first paint without
//      pulling 30 KB of synths to answer a yes/no question.
//   2. The pure logic — which life event fires under what gate, with what pan, and the per-run
//      keyboard. Testable without an AudioContext, and small.
//   3. The façades. Same API the call sites always used, so nothing downstream learned a new shape:
//      `enabled` is answered synchronously from the preference; every command either forwards to a
//      loaded engine or queues behind the one in-flight import.
//
// The façades own persistence, and the engines no longer touch localStorage — an engine exists only
// because a façade already decided it should be on.

/** Preference keys. Read here, written here, and nowhere else. */
const PREF_KEY = 'musterd.live.sound';
const ROOM_PREF_KEY = 'musterd.live.roomtone';

/** A stored on/off preference. SSR-safe, and safe in private mode where storage throws on read. */
function readPref(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writePref(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* private mode / disabled storage — fine, just don't persist */
  }
}

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

/** What the scene tells the sound engine. Pushed one way (scene → sound), never read back — that is
 *  what keeps this file testable without a canvas. `x` values are screen positions in [-1, 1]. */
export interface LifeContext {
  /** Pairs of members actually near each other — sharing a pod, the huddle, or the lounge. */
  pairs: ReadonlyArray<{ x: number }>;
  /** The office dog, when it is on the floor. */
  dog: { x: number; walking: boolean } | null;
}

/** An occupancy nobody has pushed yet: an empty office, which must not talk to itself. */
export const EMPTY_LIFE: LifeContext = { pairs: [], dog: null };

/**
 * The mix. Work and talk stay the majority on purpose — the new events are seasoning, and a room
 * where the stapler fires as often as the typing is a cartoon. Weights sum to 1; the gated events'
 * weight is REDISTRIBUTED (by renormalising over what is available) when their condition fails, so
 * an empty office is not simply quieter by the chatter slots.
 */
export const LIFE_EVENTS: ReadonlyArray<{ name: string; weight: number }> = [
  { name: 'keys', weight: 0.34 },
  { name: 'murmur', weight: 0.17 },
  { name: 'whisper', weight: 0.04 },
  { name: 'tap', weight: 0.07 },
  { name: 'creak', weight: 0.06 },
  { name: 'chime', weight: 0.04 },
  { name: 'softTap', weight: 0.03 },
  { name: 'stapler', weight: 0.03 },
  { name: 'drawer', weight: 0.03 },
  { name: 'footsteps', weight: 0.04 },
  { name: 'sip', weight: 0.03 },
  { name: 'blow', weight: 0.02 },
  { name: 'water', weight: 0.02 },
  { name: 'eating', weight: 0.03 },
  { name: 'paws', weight: 0.025 },
  { name: 'jingle', weight: 0.01 },
  { name: 'yawn', weight: 0.01 },
  // A bark on a timer is an alarm clock. Rarity IS the design; do not "fix" this upward.
  { name: 'bark', weight: 0.005 },
];

const CHATTER = new Set(['murmur', 'whisper']);
const DOG_EVENTS = new Set(['paws', 'jingle', 'yawn', 'bark']);

/** Is this event available under the current occupancy? Chatter needs a co-located pair — a headcount
 *  of two at opposite ends of the floor is not a conversation. Paws need the dog actually walking. */
function lifeAvailable(name: string, ctx: LifeContext): boolean {
  if (CHATTER.has(name)) return ctx.pairs.length > 0;
  if (name === 'paws') return ctx.dog?.walking === true;
  if (DOG_EVENTS.has(name)) return ctx.dog != null;
  return true;
}

/** Pick the next life event for a uniform `roll` in [0, 1). Pure and deterministic. */
export function pickLifeEvent(roll: number, ctx: LifeContext): string {
  const avail = LIFE_EVENTS.filter((e) => lifeAvailable(e.name, ctx));
  const total = avail.reduce((sum, e) => sum + e.weight, 0);
  let acc = 0;
  for (const e of avail) {
    acc += e.weight;
    if (roll * total < acc) return e.name;
  }
  return avail[avail.length - 1]!.name;
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
// ── the façades ──────────────────────────────────────────────────────────────────────────────────
//
// One in-flight import, shared. Everything below is a thin forwarder whose only real job is to be
// callable before the thing it forwards to exists.

type Engine = typeof import('./soundEngine');

let pending: Promise<Engine> | null = null;

/** Load the engines, once. The `import()` is what keeps them off the eager graph — don't hoist it. */
function loadEngines(): Promise<Engine> {
  pending ??= import('./soundEngine');
  return pending;
}

class FirehoseSoundFacade {
  /** The stored preference, answered synchronously — the toggle renders off this on first paint. */
  enabled = readPref(PREF_KEY);
  private engine: Engine['firehoseEngine'] | null = null;

  private withEngine(run: (e: Engine['firehoseEngine']) => void): void {
    if (this.engine) {
      run(this.engine);
      return;
    }
    void loadEngines().then((m) => {
      this.engine = m.firehoseEngine;
      run(m.firehoseEngine);
    });
  }

  /** Toggle sound. Enabling must come from a user gesture so the AudioContext can start. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    writePref(PREF_KEY, on);
    // Turning it OFF before the engines ever loaded is already true: nothing is playing.
    if (on) this.withEngine((e) => e.setEnabled(true));
    else this.engine?.setEnabled(false);
  }

  /**
   * Turn sound on for a capture, without persisting. `/broadcast` only (ADR 228).
   *
   * Separate from `setEnabled` deliberately, rather than a `persist?: boolean` parameter: a stream
   * source must never rewrite the preference a human set on this machine, and the call site should
   * say so in its own name.
   */
  enableForBroadcast(): void {
    this.enabled = true;
    this.withEngine((e) => e.enableForBroadcast());
  }

  /**
   * Play the cue for an act.
   *
   * A cue that arrives before the engines are downloaded is DROPPED, not queued — it starts the load
   * and plays nothing. Queueing them would collapse a burst into one simultaneous chord the moment
   * the chunk lands, which is the one thing the cue design is most careful to avoid. This is the same
   * call the broadcast throttle already makes: the visual channel carries every act, so the audio
   * does not owe the viewer completeness.
   */
  chime(act: string): void {
    if (!this.enabled) return;
    if (this.engine) this.engine.chime(act);
    else this.withEngine(() => {});
  }
}

class RoomToneFacade {
  /** The stored preference, answered synchronously — see FirehoseSoundFacade.enabled. */
  enabled = readPref(ROOM_PREF_KEY);
  private engine: Engine['roomToneEngine'] | null = null;
  /** Held here until an engine exists to receive it. An empty office is quiet. */
  private occupancy: LifeContext = EMPTY_LIFE;

  private withEngine(run: (e: Engine['roomToneEngine']) => void): void {
    if (this.engine) {
      run(this.engine);
      return;
    }
    void loadEngines().then((m) => {
      this.engine = m.roomToneEngine;
      // The scene has been pushing occupancy at us all along; hand over the latest before starting,
      // so the bed's first life event knows who is in the room.
      m.roomToneEngine.setOccupancy(this.occupancy);
      run(m.roomToneEngine);
    });
  }

  /** Toggle the bed. Enabling must come from a user gesture so the AudioContext can start. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    writePref(ROOM_PREF_KEY, on);
    if (on) this.withEngine((e) => e.setEnabled(true));
    else this.engine?.setEnabled(false);
  }

  /**
   * A preference that survives a reload cannot legally resume itself — the page has had no gesture
   * yet, so the context would be born suspended. `resumeIfEnabled` is what the *first* interaction
   * calls: if the viewer already asked for room tone in an earlier session, this is where it actually
   * starts, and where the engines are fetched for the first time. No gesture ever arrives → nothing
   * is downloaded and nothing plays, which is the correct outcome, not a bug.
   */
  resumeIfEnabled(): void {
    if (this.enabled) this.withEngine((e) => e.setEnabled(true));
  }

  /** Turn the bed on for a capture, without persisting and without the visibility gate (ADR 228). */
  enableForBroadcast(): void {
    this.enabled = true;
    this.withEngine((e) => e.enableForBroadcast());
  }

  /** The scene pushes who is near whom (and where the dog is). One-way by design — see LifeContext.
   *  Called from the office rAF loop, so it must stay a field write when there is no engine yet. */
  setOccupancy(ctx: LifeContext): void {
    this.occupancy = ctx;
    this.engine?.setOccupancy(ctx);
  }
}

/** Process-wide singletons — the toggles write them, the stream hook and the scene read them. */
export const firehoseSound = new FirehoseSoundFacade();
export const roomTone = new RoomToneFacade();
