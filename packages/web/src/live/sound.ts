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
//   2. The `LifeContext` contract the scene pushes occupancy through — a type and one empty
//      constant, so the eager graph carries no roll logic (that lives in `soundLife.ts`, loaded
//      with the engines).
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

/** What the scene tells the sound engine. Pushed one way (scene → sound), never read back — that is
 *  what keeps this file testable without a canvas. `x` values are screen positions in [-1, 1]. */
export interface LifeContext {
  /** Pairs of members actually near each other — sharing a pod, the huddle, or the lounge. */
  pairs: ReadonlyArray<{ x: number }>;
  /** The office dog, when it is on the floor. */
  dog: { x: number; walking: boolean } | null;
  /**
   * Desks whose seats are audibly working. Collected by `posture === 'working'` at a desk — never
   * `activity`, which lags: a stale activity with posture projected to idle used to sit on the
   * lounge couch drumming an imaginary keyboard, and this field keyed on activity would be that bug
   * in the ears. Same predicate the renderer types and lights screens on (E2 spec §2).
   */
  working: ReadonlyArray<{ x: number; seed: number }>;
  /** Work intensity 0..1 — working share of present seats, nudged by recent act rate (scene-side). */
  density: number;
  /** From the lighting envelope, so audio and window light can never disagree. */
  daylight: number;
  /** Office clock, 0..24 PST — the same value the wall clock renders; `?light=HH` overrides audio too. */
  hours: number;
}

/** An occupancy nobody has pushed yet: an empty office, which must not talk to itself. Noon-lit so
 *  neither day-cycle event is available — the neutral hour, not a phantom midnight. */
export const EMPTY_LIFE: LifeContext = {
  pairs: [],
  dog: null,
  working: [],
  density: 0,
  daylight: 1,
  hours: 12,
};

/** A canvas pixel x → raw pan in [-1, 1]. RAW on purpose: the ×0.75 stereo squeeze belongs to the
 *  engine alone (`momentPan`), so a value converted here must never be squeezed by the caller too.
 *  An unsized canvas yields centre, not NaN. */
export function screenPan(px: number, width: number): number {
  if (width <= 0) return 0;
  return Math.max(-1, Math.min(1, (px / width) * 2 - 1));
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
  /** Broadcast never counts as hidden — a capture box has no tab to front (ADR 228). */
  private broadcast = false;
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
    this.broadcast = true;
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
    // A hidden tab does not chime (broadcast excepted — a capture box is hidden by construction,
    // ADR 228). The room-tone engine has always had this gate; the act cues did not, and the gap was
    // audible (nick, 2026-08-05): agent seats verify /live in the harness browser pane, which
    // reports `document.hidden === true` for its whole lifetime — one such pane with sound toggled
    // on chimed the whole team's acts from a laptop with no browser window open anywhere. A cue for
    // a room nobody is looking at is noise by definition; the title-count badge still carries the
    // arrival.
    if (!this.broadcast && typeof document !== 'undefined' && document.hidden) return;
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

  /**
   * A placed one-shot for a room milestone (E3): fanfare at the celebrant, the door, an ask's
   * weight. `pan` is raw [-1, 1] (`screenPan` at the emit site); the engine owns the stereo
   * squeeze. A moment that arrives before the engine chunk lands is DROPPED, never queued — the
   * same rule as the firehose cues, for the same reason (a queued burst lands as one chord).
   */
  moment(name: import('./soundLife').Moment, pan: number, panTo?: number): void {
    if (!this.enabled) return;
    this.engine?.moment(name, pan, panTo);
  }
}

/** Process-wide singletons — the toggles write them, the stream hook and the scene read them. */
export const firehoseSound = new FirehoseSoundFacade();
export const roomTone = new RoomToneFacade();
