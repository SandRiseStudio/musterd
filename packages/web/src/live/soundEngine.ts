// The WebAudio engines — a tiny synth that gives every live act its own short, musical cue, and the
// room-tone bed underneath it. **This module is loaded lazily** (see the façades in `sound.ts`): it
// is the biggest thing on /live that a viewer with sound off never needs, so it is not allowed on the
// eager graph the byte budget measures (packages/web/AGENTS.md, ADR 183).
//
// No audio assets: each act is a handful of scheduled oscillator notes drawn from a consonant
// pentatonic set, so even a burst of simultaneous arrivals stays pleasant rather than noisy. The
// engines are opt-in (default OFF) and only ever build their AudioContext from the enabling click,
// which is what browser autoplay policy requires. Because the façade imports this module *from* that
// click, the context is built one microtask late — legal because activation is STICKY once the user
// has interacted, not transient, and `start`/`ensureContext` resume a context born suspended anyway.
//
// The preference keys, their persistence, and the pure logic (which event fires, under what gate,
// with what pan) all live in `sound.ts`. Nothing here reads localStorage: an engine only exists
// because a façade already decided it should be on, and told it so.

import { EMPTY_LIFE, type LifeContext } from './sound';
import {
  keyboardFor,
  keypressPlan,
  lifeGapFor,
  type Moment,
  momentPan,
  panFor,
  pickLifeEvent,
  pickWorkDesk,
  shouldChime,
  shouldPlayMoment,
} from './soundLife';

/** One scheduled note: a frequency, a start offset (s), a length (s), a waveform, and a peak gain. */
interface Note {
  freq: number;
  /** delay from the cue's start, seconds */
  t: number;
  /** duration, seconds */
  dur: number;
  type: OscillatorType;
  gain: number;
}

// A C-major pentatonic ladder — any mix of these rings consonant, so overlapping cues never clash.
const E4 = 329.63;
const G4 = 392.0;
const A4 = 440.0;
const C5 = 523.25;
const D5 = 587.33;
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880.0;
const C6 = 1046.5;

const tri: OscillatorType = 'triangle';
const sine: OscillatorType = 'sine';

/**
 * Per-act cue recipes. The shape mirrors the visual act tones (format.ts): resolve is the warm,
 * satisfying major arpeggio that pairs with its on-screen "settle"; request_help rises to grab
 * attention; status is a near-subliminal tick; decline falls. `message` is the default fallback.
 */
const CUES: Record<string, Note[]> = {
  message: [{ freq: E5, t: 0, dur: 0.32, type: tri, gain: 0.1 }],
  status_update: [{ freq: A5, t: 0, dur: 0.18, type: sine, gain: 0.05 }],
  request_help: [
    { freq: E5, t: 0, dur: 0.28, type: tri, gain: 0.11 },
    { freq: A5, t: 0.11, dur: 0.36, type: tri, gain: 0.12 },
  ],
  handoff: [
    { freq: G5, t: 0, dur: 0.26, type: sine, gain: 0.1 },
    { freq: C6, t: 0.12, dur: 0.34, type: sine, gain: 0.1 },
  ],
  accept: [
    { freq: E5, t: 0, dur: 0.26, type: sine, gain: 0.1 },
    { freq: G5, t: 0.12, dur: 0.34, type: sine, gain: 0.1 },
  ],
  decline: [
    { freq: G4, t: 0, dur: 0.28, type: sine, gain: 0.1 },
    { freq: E4, t: 0.12, dur: 0.4, type: sine, gain: 0.09 },
  ],
  wait: [{ freq: D5, t: 0, dur: 0.46, type: sine, gain: 0.07 }],
  // The to-human ask (ADR 147/149) — a doorbell: two clear rising strikes, brighter than
  // request_help (this one is aimed at a person and carries a clock).
  ask: [
    { freq: G5, t: 0, dur: 0.3, type: tri, gain: 0.12 },
    { freq: C6, t: 0.14, dur: 0.5, type: tri, gain: 0.13 },
  ],
  // Steering trio (ADR 103). steer is the loudest — an assertive rising triad that grabs attention
  // (interrupt-class); challenge lifts like a spoken question; defer settles gently downward (set aside).
  steer: [
    { freq: A4, t: 0, dur: 0.2, type: tri, gain: 0.11 },
    { freq: E5, t: 0.09, dur: 0.24, type: tri, gain: 0.12 },
    { freq: A5, t: 0.18, dur: 0.42, type: tri, gain: 0.13 },
  ],
  challenge: [
    { freq: D5, t: 0, dur: 0.22, type: sine, gain: 0.09 },
    { freq: A5, t: 0.12, dur: 0.34, type: sine, gain: 0.1 },
  ],
  defer: [
    { freq: G5, t: 0, dur: 0.24, type: sine, gain: 0.08 },
    { freq: D5, t: 0.12, dur: 0.42, type: sine, gain: 0.08 },
  ],
  resolve: [
    { freq: C5, t: 0, dur: 0.34, type: sine, gain: 0.11 },
    { freq: E5, t: 0.12, dur: 0.38, type: sine, gain: 0.11 },
    { freq: G5, t: 0.24, dur: 0.6, type: sine, gain: 0.12 },
  ],
  end: [
    { freq: C5, t: 0, dur: 0.28, type: sine, gain: 0.09 },
    { freq: G4, t: 0.12, dur: 0.36, type: sine, gain: 0.08 },
  ],
};
/**
 * Broadcast master gain, linear — the ADR 228 §1.6 calibration number, measured not guessed.
 *
 * The engines are tuned for headphones at a desk, and rendered through the real hosted pipeline
 * (Fly performance-4x, null sink → ffmpeg aac, 2026-08-04) the whole mix integrated at
 * **−42.8 LUFS (LRA 1.8 LU)** — real audio, ~25 dB under where even deliberate ambience should sit
 * on a stream; a viewer at normal volume hears roughly nothing. ×4 (+12 dB) lands the bed near
 * −30 LUFS: clearly audible, still unmistakably background (this is ambience, not program — do NOT
 * normalize it toward −14 LUFS speech loudness). Retune HERE, never by scattering factors through
 * the synths — the LIFE_GAIN lesson. /live is untouched: this applies only via enableForBroadcast.
 */
const BROADCAST_MASTER_GAIN = 4;

export class FirehoseSound {
  enabled = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Throttle the cues (broadcast only — /live's tuning is unchanged and out of scope). */
  private throttled = false;
  private lastCueAt = -Infinity;
  /** Applied to the master bus when the graph is (re)built — see BROADCAST_MASTER_GAIN. */
  private masterScale = 1;

  /** Toggle sound. The façade owns the preference and its persistence; this is the audio half. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.ensureContext();
  }

  /**
   * Turn sound on for a capture. `/broadcast` only (ADR 228).
   *
   * Separate from `setEnabled` deliberately, rather than a `persist?: boolean` parameter: a stream
   * source must never rewrite the preference a human set on this machine, and the call site should
   * say so in its own name (the façade is what holds that line).
   */
  enableForBroadcast(): void {
    this.enabled = true;
    this.throttled = true;
    this.masterScale = BROADCAST_MASTER_GAIN;
    this.ensureContext();
    if (this.master) this.master.gain.value = 0.85 * this.masterScale;
  }

  private ensureContext(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      // master bus → gentle lowpass for warmth → speakers
      const master = this.ctx.createGain();
      master.gain.value = 0.85 * this.masterScale;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3600;
      master.connect(lp).connect(this.ctx.destination);
      this.master = master;
    }
    // A context created/resumed off a click starts running; resume() covers an auto-suspended one.
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Play the cue for an act. No-op unless enabled and the audio graph is live. */
  chime(act: string): void {
    if (!this.enabled) return;
    if (this.throttled) {
      const now = Date.now();
      if (!shouldChime(now, this.lastCueAt)) return;
      this.lastCueAt = now;
    }
    this.ensureContext();
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== 'running') return;
    const notes = CUES[act] ?? CUES['message']!;
    const start = ctx.currentTime + 0.005;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      osc.type = n.type;
      osc.frequency.value = n.freq;
      const g = ctx.createGain();
      const t0 = start + n.t;
      // Click-free envelope: fast attack, exponential decay to (near) silence.
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(n.gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
      osc.connect(g).connect(master);
      osc.start(t0);
      osc.stop(t0 + n.dur + 0.03);
    }
  }
}

/** Process-wide singleton, reached only through the `firehoseSound` façade in `sound.ts`. */
export const firehoseEngine = new FirehoseSound();

// ── room tone ────────────────────────────────────────────────────────────────────────────────────
//
// The sound of the office *being there*, as opposed to the sound of things happening in it. It is a
// separate engine behind a separate switch because it answers a different question: the act cues
// above tell you something arrived, this one tells you the room is inhabited. Somebody who wants a
// quiet room with audible arrivals — or a lived-in room with no pings — should get exactly that, and
// one toggle cannot serve both.
//
// Synthesised, like the cues: no audio assets, so it costs the byte budget nothing but the code (the
// packages/web perf contract). Three layers, from continuous to sparse:
//
//   1. AIR — filtered noise, the building's ventilation. The bed everything else sits on.
//   2. HUM  — a pair of very low, slightly detuned sines. Below conscious hearing on laptop speakers
//             and clearly missing when you take it away, which is exactly what room tone is.
//   3. LIFE — the sparse events: a run of keys somewhere, a murmured exchange too far away to parse,
//             a mug set down, a chair, the odd chat-app ping at someone else's desk. These are what
//             make it an OFFICE rather than an air conditioner. Every one of them is parameter-
//             jittered per play — a loop you can predict is a loop you will turn off within the hour.
//
// It is quiet on purpose ("light ambient office noise" — nick, 2026-07-28), and it stops dead on a
// hidden tab: an idle cost is paid by every viewer forever, and one left running in a background tab
// is the most annoying possible version of this feature.

/** Ceiling on the whole bed. Low enough to sit under a podcast, loud enough to miss when it stops. */
const ROOM_GAIN = 0.075;
// The gap between sparse events now lives in sound.ts (`LIFE_GAP` / `lifeGapFor`): it scales with
// work density, and the scaling is logic the tests hold still without an AudioContext.
/**
 * Makeup gain on the whole LIFE layer, and the reason it needs one.
 *
 * Every life event is band-limited noise: a bandpass on white noise throws away all but a sliver of
 * the spectrum, so its envelope value (`0.07` for a keystroke) multiplies a signal that is *already*
 * 20–40 dB down. The AIR bed is a wide 380 Hz lowpass, where most of the energy survives. Written
 * without compensation the two layers are not on the same scale at all, and the first version of this
 * feature shipped inaudible: rendered offline through this exact graph, the bed peaked at −35 dBFS
 * while a keystroke peaked at −58.9 and a murmured syllable at −75.5 — 24 and 40 dB *under* the
 * ventilation that was supposed to sit behind them (nick, 2026-07-29: "im not sure if I hear any of
 * the added life audio"). They were there; the bed was burying them.
 *
 * So the layer gets its own bus and the per-event gains stay *relative* (a keystroke louder than a
 * mug, a mug louder than nothing), with this one number carrying the makeup. Retune the layer here,
 * never by scattering factors through five synths. Target: events peak a few dB ABOVE the bed, which
 * is what a foreground sound in a real room does.
 *
 * As re-measured through the same offline graph, peaks against a −33.7 dBFS bed: keystroke −25,
 * murmur −25, chime −30, mug −30, creak −31. **Those readings carry about ±3 dB** — each render draws
 *
 * 2026-07-30, typing rebuild: re-rendered through the same chain shapes (stereo OfflineAudioContext,
 * so absolute numbers shifted — the bed read −40.2 in that render; only the DELTAS are comparable).
 * The old single-transient keystroke sat **+13.5 dB over the bed**, which was the "too loud". The
 * two-transient press now lands at bed +0.4 (thock) and +1.3 (release click) — at the bed, which is
 * where a keyboard three desks away belongs. The new events reuse the existing shapes at or below
 * the old mug/creak envelope numbers and inherit this calibration.
 * a fresh random noise buffer, and the peak of a narrowband noise burst wanders that much. A control
 * sweep confirmed the harness itself tracks gain at ~6 dB per doubling, so differences of that order
 * are real and anything smaller is not. Do not tune this layer to a finer resolution than that.
 */
const LIFE_GAIN = 34;

export class RoomTone {
  enabled = false;
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  /** The LIFE layer's own bus (see `LIFE_GAIN`) — sparse events land here, never straight on `bus`. */
  private lifeBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watching = false;
  /** Broadcast mode — see `enableForBroadcast`. Set before `start()`, never cleared. */
  private broadcast = false;
  /** What the scene last told us about who is near whom. Starts empty: an empty office is quiet. */
  private occupancy: LifeContext = EMPTY_LIFE;
  /** When the last milestone moment played — the E3 burst throttle's clock. */
  private lastMomentAt = -Infinity;

  /** Toggle the bed. The façade owns the preference and its persistence; this is the audio half. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.start();
    else this.stop();
  }

  /**
   * Turn the bed on for a capture, without the visibility gate (ADR 228).
   *
   * The gate exists so a bed left running in a background tab is not the most annoying possible
   * version of this feature. A capture box has no tab and no listener whose attention could wander
   * — it is the same reason broadcast already ignores `prefers-reduced-motion`. Non-theoretical:
   * headless and embedded Chrome surfaces have been observed reporting `document.hidden === true`
   * for their whole lifetime, which would suspend the bed for the entire stream.
   */
  enableForBroadcast(): void {
    this.broadcast = true;
    this.enabled = true;
    this.start();
  }

  /** Visibility, as broadcast sees it: never hidden. */
  private isHidden(): boolean {
    return !this.broadcast && document.hidden;
  }

  /** The scene pushes who is near whom (and where the dog is). One-way by design — see LifeContext. */
  setOccupancy(ctx: LifeContext): void {
    this.occupancy = ctx;
  }

  private start(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.bus) return; // already built and running

    const ctx = this.ctx;
    const bus = ctx.createGain();
    // Faded in over a second and a half. Room tone that snaps on announces itself as an effect; the
    // whole illusion is that it was always there and you only just noticed.
    bus.gain.setValueAtTime(0.0001, ctx.currentTime);
    // The broadcast master gain rides the same bed ramp — one number, applied at the one bus.
    bus.gain.exponentialRampToValueAtTime(
      ROOM_GAIN * (this.broadcast ? BROADCAST_MASTER_GAIN : 1),
      ctx.currentTime + 1.5,
    );
    bus.connect(ctx.destination);
    this.bus = bus;

    // 1 · AIR. One second of noise on a loop, rolled off hard — what is left after a lowpass this low
    // has no seam to hear, so a one-second buffer does the work of a recorded minute.
    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuffer(ctx);
    air.loop = true;
    const airLp = ctx.createBiquadFilter();
    airLp.type = 'lowpass';
    airLp.frequency.value = 380;
    airLp.Q.value = 0.4;
    const airGain = ctx.createGain();
    // Turned down from 0.5 (nick, 2026-07-29: "turn down the ambient white noise slightly") — the
    // ventilation recedes to a bed and the LIFE events above it carry the room instead.
    airGain.gain.value = 0.34;
    air.connect(airLp).connect(airGain).connect(bus);
    air.start();
    this.sources.push(air);

    // A slow swell across the bed, so the ventilation breathes instead of sitting at one level. Well
    // under a cycle a minute: perceptible as life, never as a wobble.
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.03;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 0.12;
    swell.connect(swellDepth).connect(airGain.gain);
    swell.start();
    this.sources.push(swell);

    // 2 · HUM. Two low sines a few cents apart — the beat between them is the "big room" cue, and it
    // is the detune doing that work, not the pitch.
    for (const [f, g] of [
      [57.5, 0.1],
      [58.9, 0.08],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const gain = ctx.createGain();
      gain.gain.value = g;
      osc.connect(gain).connect(bus);
      osc.start();
      this.sources.push(osc);
    }

    // 3 · LIFE, on its own bus so the band-limited events can be lifted clear of the wideband bed.
    const lifeBus = ctx.createGain();
    lifeBus.gain.value = LIFE_GAIN;
    lifeBus.connect(bus);
    this.lifeBus = lifeBus;
    this.armLife();

    // A bed left playing to a tab nobody is looking at is the worst version of this feature.
    // (A broadcast capture has no watcher to gate on, so it never registers the listener at all.)
    if (!this.watching && !this.broadcast) {
      this.watching = true;
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    // `visibilitychange` only fires on a CHANGE, so the listener alone never catches the case where
    // the tab is *already* hidden when the bed starts — a preference restored on a background tab,
    // or a viewer who switched away between the click and the context opening. Check the state we
    // are actually in, rather than waiting for it to be announced.
    if (this.isHidden()) void ctx.suspend();
  }

  private onVisibility = (): void => {
    if (!this.ctx || !this.enabled) return;
    if (this.isHidden()) void this.ctx.suspend();
    else void this.ctx.resume();
  };

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    // Fade out before tearing down, or the whole bed ends on a click.
    const end = ctx.currentTime + 0.7;
    bus.gain.cancelScheduledValues(ctx.currentTime);
    bus.gain.setValueAtTime(Math.max(bus.gain.value, 0.0001), ctx.currentTime);
    bus.gain.exponentialRampToValueAtTime(0.0001, end);
    const sources = this.sources;
    this.sources = [];
    this.bus = null;
    this.lifeBus = null;
    for (const s of sources) s.stop(end + 0.05);
    setTimeout(() => bus.disconnect(), 900);
  }

  /** One second of white noise, built once and reused by every layer that needs a hiss. */
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  /**
   * A placed room milestone (E3): fanfare at the celebrant, the door opening, an ask's weight.
   * On the LIFE bus so it inherits the bed's calibration; throttled so a burst of accepts plays
   * once (dropped, never queued); the ×0.75 stereo squeeze happens HERE and nowhere else —
   * `pan` arrives raw [-1, 1] from `screenPan` at the emit site.
   */
  moment(name: Moment, pan: number): void {
    const ctx = this.ctx;
    const bus = this.lifeBus;
    if (!ctx || !bus || ctx.state !== 'running' || this.isHidden()) return;
    const now = Date.now();
    if (!shouldPlayMoment(now, this.lastMomentAt)) return;
    this.lastMomentAt = now;
    const panNode = ctx.createStereoPanner?.();
    const out = panNode ?? ctx.createGain();
    if (panNode) panNode.pan.value = momentPan(pan);
    out.connect(bus);
    setTimeout(() => out.disconnect(), 4000);
    switch (name) {
      case 'fanfare': return this.fanfare(ctx, out);
      case 'door': return this.doorMoment(ctx, out);
      case 'askbell': return this.askbell(ctx, out);
    }
  }

  /** Acceptance lands (E3): a quick rising major triad off the cue ladder, and a soft paper
   *  flutter underneath — the confetti's own sound. A celebration you notice, not a jingle. */
  private fanfare(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    const triad = [523.25, 659.25, 783.99]; // C5 E5 G5 — the resolve chord, placed in the room
    triad.forEach((f, i) => {
      this.ping(ctx, out, t0 + i * (0.07 + Math.random() * 0.03), f * (0.995 + Math.random() * 0.01), 0.02 + Math.random() * 0.006);
    });
    // The flutter: a handful of tiny bright taps scattered over the ring — paper coming down.
    let at = t0 + 0.25;
    for (let i = 0; i < 5 + Math.floor(Math.random() * 4); i++) {
      this.click(ctx, out, at, 1800 + Math.random() * 1400, 0.012 + Math.random() * 0.008, 0.03);
      at += 0.05 + Math.random() * 0.07;
    }
  }

  /** The door (E3): a low latch click, the closer arm's short sigh, then a few steps from that side. */
  private doorMoment(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    this.click(ctx, out, t0, 320 + Math.random() * 120, 0.08, 0.05); // the latch
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t0 + 0.08);
    lp.frequency.exponentialRampToValueAtTime(320, t0 + 0.55);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0 + 0.08);
    g.gain.exponentialRampToValueAtTime(0.045, t0 + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55); // the closer's sigh
    src.connect(lp).connect(g).connect(out);
    src.start(t0 + 0.08);
    src.stop(t0 + 0.6);
    let at = t0 + 0.45;
    for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) {
      this.click(ctx, out, at, 110 + Math.random() * 60, 0.07, 0.07); // steps from the door's side
      at += 0.4 + Math.random() * 0.12;
    }
  }

  /** An ask lands (E3): one soft held tone with a slow decay — weight, not alarm, and quieter than
   *  the firehose doorbell that may ring beside it. */
  private askbell(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    const f = 440 * (0.98 + Math.random() * 0.05);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.018, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + 1.25);
  }

  /** Schedule the next sparse event, and re-arm from it. One timer, always. The gap tightens with
   *  work density — a full sprint hums about twice as often as a quiet room (E2 spec §4). */
  private armLife(): void {
    clearTimeout(this.timer);
    const [lo, hi] = lifeGapFor(this.occupancy.density);
    const wait = lo + Math.random() * (hi - lo);
    this.timer = setTimeout(() => {
      if (this.bus && this.ctx?.state === 'running' && !this.isHidden()) this.life();
      this.armLife();
    }, wait * 1000);
  }

  /** Pick one of the room's small noises and play it, somewhere off to one side. */
  private life(): void {
    const ctx = this.ctx;
    const bus = this.lifeBus;
    if (!ctx || !bus) return;
    // Placed across the stereo field, never dead centre: everything in an office happens at somebody
    // else's desk, and a sound in the middle of your head is a sound you made.
    const now = Date.now();
    const name = pickLifeEvent(Math.random(), this.occupancy, now);
    const pan = ctx.createStereoPanner?.();
    const out = pan ?? ctx.createGain();
    // Positioned events pan to where they are on screen: work sounds to the working desk that makes
    // them (E2 spec §3), chatter to the pair, the dog to the dog; the rest land somewhere off to one
    // side, the way the layer always has.
    const desk = pickWorkDesk(name, Math.random(), this.occupancy, now);
    const at = desk ? desk.x * 0.75 : panFor(name, this.occupancy);
    if (pan) pan.pan.value = at ?? (Math.random() * 2 - 1) * 0.75;
    out.connect(bus);
    // Long enough for the longest murmur or typing run to finish before its channel goes away.
    setTimeout(() => out.disconnect(), 9000);

    // Every branch jitters its own parameters, so even the same event twice in a row never plays the
    // same twice (nick, 2026-07-29: "very dynamic and variable so they don't get old").
    switch (name) {
      case 'keys': return this.keys(ctx, out, desk?.seed);
      case 'murmur': return this.murmur(ctx, out, false);
      case 'whisper': return this.murmur(ctx, out, true);
      case 'tap': return this.tap(ctx, out, 0.9);
      case 'softTap': return this.tap(ctx, out, 0.35);
      case 'creak': return this.creak(ctx, out);
      case 'chime': return this.chime(ctx, out);
      case 'stapler': return this.stapler(ctx, out);
      case 'drawer': return this.drawer(ctx, out);
      case 'footsteps': return this.footsteps(ctx, out);
      case 'sip': return this.sip(ctx, out, 1);
      case 'water': return this.sip(ctx, out, 0.72);
      case 'blow': return this.blow(ctx, out);
      case 'eating': return this.eating(ctx, out);
      case 'paws': return this.paws(ctx, out);
      case 'jingle': return this.jingle(ctx, out);
      case 'yawn': return this.blow(ctx, out, true);
      case 'bark': return this.bark(ctx, out);
      case 'birds': return this.birds(ctx, out);
      case 'nightair': return this.nightair(ctx, out);
    }
  }

  /** Somebody typing, a few desks away: a run of keypresses at a human, uneven rate. Sometimes a
   *  quick flurry, sometimes a long thought typed out — with a thinking pause in the middle of the
   *  long ones. A uniform run is what the ear learns first. One `Keyboard` per run (see
   *  `keyboardFor`), two transients per key (see `keypressPlan`) — and the whole thing sits at the
   *  bed's level now, not 9 dB over it, which was the "too loud" half of the complaint. */
  private keys(ctx: AudioContext, out: AudioNode, deskSeed?: number): void {
    // A placed burst plays the desk's own keyboard (E2 spec §3) — the same seed every time, so a
    // desk sounds like itself across bursts. An unplaced one draws a stranger's, as it always has.
    const kb = keyboardFor(deskSeed ?? Math.floor(Math.random() * 0xffffffff));
    const long = Math.random() < 0.3;
    const n = long ? 14 + Math.floor(Math.random() * 12) : 4 + Math.floor(Math.random() * 9);
    const pauseAt = long ? 5 + Math.floor(Math.random() * (n - 8)) : -1;
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < n; i++) {
      for (const tr of keypressPlan(kb)) {
        this.click(ctx, out, at + tr.at, tr.freq * (0.94 + Math.random() * 0.12), tr.gain, tr.dur);
      }
      at += 0.055 + Math.random() * 0.075; // the jitter IS the humanity
      if (i === pauseAt) at += 0.5 + Math.random() * 1.1; // rereading the sentence
    }
  }

  /** A chat app pinging at somebody else's desk: two quick soft notes. Drawn from a few different
   *  apps' worth of intervals — rising, wider, falling — so no two pings in a row are the same one. */
  private chime(ctx: AudioContext, out: AudioNode): void {
    const sets: [number, number][] = [
      [523.25, 783.99], // C5 → G5
      [587.33, 880.0], // D5 → A5
      [659.25, 987.77], // E5 → B5
      [783.99, 659.25], // G5 → E5 — the falling one
    ];
    const [f1, f2] = sets[Math.floor(Math.random() * sets.length)]!;
    // A pure sine loses far less through its (nonexistent) filtering than the noise-based events do,
    // so on the shared LIFE bus it needs the *smallest* number here to sit level with them. Kept a
    // touch under the keystroke: this is always a ping at somebody else's desk, never yours.
    const g = 0.009 + Math.random() * 0.006;
    const t0 = ctx.currentTime + 0.02;
    this.ping(ctx, out, t0, f1, g);
    this.ping(ctx, out, t0 + 0.09 + Math.random() * 0.05, f2, g * 1.15);
  }

  /** One soft sine strike with a fast attack and a long ring — the body of a notification note. */
  private ping(ctx: AudioContext, out: AudioNode, at: number, freq: number, gain: number): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + 0.55);
  }

  /** Two people talking a few desks away — too far to make out a word, which is the point. Band-passed
   *  noise shaped into syllables, two voice registers trading short phrases; phrase count, syllable
   *  count, register, contour and pacing all jittered, so no two conversations are alike. */
  private murmur(ctx: AudioContext, out: AudioNode, whisper: boolean): void {
    // A whisper is the same exchange with the voice taken out of it: quieter, and pushed into a
    // tighter, breathier band — the shape of consonants carrying without pitch.
    const level = whisper ? 0.45 : 1;
    let at = ctx.currentTime + 0.05;
    const phrases = 2 + Math.floor(Math.random() * 2);
    for (let ph = 0; ph < phrases; ph++) {
      // alternate speakers: one higher register, one lower
      // Formant centre, not vocal-fold pitch: what carries through a room is the resonance band
      // around 300–650 Hz, and centring the band on a 130 Hz fundamental put nearly all the energy
      // below where the muffling lowpass could shape it (it was also the quietest event by 17 dB).
      // Two registers, an upper and a lower speaker, so an exchange has two people in it.
      const base = ph % 2 === 0 ? 460 + Math.random() * 190 : 310 + Math.random() * 130;
      const voice = whisper ? base * 1.5 : base;
      const syllables = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < syllables; i++) {
        const dur = 0.09 + Math.random() * 0.11;
        this.voiceBurst(ctx, out, at, voice * (0.9 + Math.random() * 0.35), dur, level);
        at += dur + 0.02 + Math.random() * 0.06;
      }
      at += 0.25 + Math.random() * 0.55; // the beat where the other one answers
    }
  }

  /** One spoken syllable, heard through the room: a noise burst through a gliding bandpass (the pitch
   *  contour of speech) then a hard lowpass (the wall between you and the words). */
  private voiceBurst(ctx: AudioContext, out: AudioNode, at: number, freq: number, dur: number, level = 1): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // Wide (Q 1.6, was 4.5): a narrow band on noise is a whistle, and it also starved the event of
    // nearly all its energy. A broad formant band reads as a voice and leaves the lowpass below
    // something to actually muffle.
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(freq, at);
    bp.frequency.exponentialRampToValueAtTime(freq * (0.85 + Math.random() * 0.3), at + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime((0.075 + Math.random() * 0.028) * level, at + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(lp).connect(g).connect(out);
    src.start(at);
    src.stop(at + dur + 0.03);
  }

  /** A mug, a stapler, something set down on a desk. `body` picks how heavy it lands. */
  private tap(ctx: AudioContext, out: AudioNode, body: number): void {
    this.click(ctx, out, ctx.currentTime + 0.02, 260 + Math.random() * 420, 0.12 * body, 0.13);
  }

  /** A chair taking somebody's weight — a short downward glide, which is the whole gesture. */
  private creak(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 7;
    bp.frequency.setValueAtTime(520, t0);
    bp.frequency.exponentialRampToValueAtTime(300, t0 + 0.42);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    // Q 7 is the narrowest band of any life event, so it loses the most and needs the most back.
    g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + 0.5);
  }

  /** A stapler: the soft press of the arm, then the sharp ka-CHUNK of the staple setting. Two
   *  transients with the weight on the second, which is the opposite of a keypress — that reversal
   *  is what keeps them from reading as the same object. */
  private stapler(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    this.click(ctx, out, t0, 380 + Math.random() * 120, 0.05, 0.04);
    this.click(ctx, out, t0 + 0.07 + Math.random() * 0.03, 900 + Math.random() * 300, 0.14, 0.05);
  }

  /** A wooden drawer: a low slide swelling over a third of a second, ended by a hard stop. The slide
   *  is a noise swell with NO attack transient — the stop is the only edge, which is what makes it a
   *  drawer and not a knock followed by a hiss. */
  private drawer(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    const dur = 0.3 + Math.random() * 0.2;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(180 + Math.random() * 80, t0);
    bp.frequency.exponentialRampToValueAtTime(260 + Math.random() * 80, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.1, t0 + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
    this.click(ctx, out, t0 + dur, 200 + Math.random() * 100, 0.11, 0.06); // the stop
  }

  /** Somebody walking past: paced pairs of soft low thuds. The pan drift across the field is the
   *  whole effect — footsteps that stay in one place are a woodpecker. */
  private footsteps(ctx: AudioContext, out: AudioNode): void {
    const steps = 4 + Math.floor(Math.random() * 4);
    const pace = 0.42 + Math.random() * 0.14;
    const from = (Math.random() * 2 - 1) * 0.7;
    const dir = Math.random() < 0.5 ? 1 : -1;
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < steps; i++) {
      // Per-step pan: a small chain per thud, drifting across the field as they cross the room.
      const pan = ctx.createStereoPanner?.();
      const leg: AudioNode = pan ?? ctx.createGain();
      if (pan) pan.pan.value = Math.max(-1, Math.min(1, from + dir * (i / steps) * 0.6));
      leg.connect(out);
      this.click(ctx, leg, at, 110 + Math.random() * 60, 0.09, 0.07);
      at += pace * (0.92 + Math.random() * 0.16);
    }
  }

  /** A sip — coffee at full body, water lower and wetter via `body`. A short liquid intake, then the
   *  tiny swallow underneath it. */
  private sip(ctx: AudioContext, out: AudioNode, body: number): void {
    const t0 = ctx.currentTime + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3.5;
    bp.frequency.setValueAtTime(1400 * body, t0);
    bp.frequency.exponentialRampToValueAtTime(900 * body, t0 + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.055, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + 0.2);
    this.click(ctx, out, t0 + 0.22 + Math.random() * 0.05, 240 * body, 0.05, 0.06); // the swallow
  }

  /** Blowing on a hot coffee — or, with `long`, a yawn: a breath swell through a slow-opening
   *  lowpass, no transient anywhere. The absence of an edge IS the sound. */
  private blow(ctx: AudioContext, out: AudioNode, long = false): void {
    const t0 = ctx.currentTime + 0.02;
    const dur = long ? 0.9 + Math.random() * 0.4 : 0.45 + Math.random() * 0.2;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t0);
    // A yawn's jaw opens the tract wider than pursed lips ever do — same gesture, bigger sweep.
    lp.frequency.exponentialRampToValueAtTime(long ? 1600 : 1100, t0 + dur * 0.45);
    lp.frequency.exponentialRampToValueAtTime(420, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(long ? 0.05 : 0.065, t0 + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  /** Somebody eating at their desk: soft irregular crunches at an uneven rate — the irregularity is
   *  what separates chewing from machinery. */
  private eating(ctx: AudioContext, out: AudioNode): void {
    const bites = 3 + Math.floor(Math.random() * 4);
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < bites; i++) {
      this.click(ctx, out, at, 700 + Math.random() * 500, 0.045 + Math.random() * 0.02, 0.05 + Math.random() * 0.03);
      at += 0.28 + Math.random() * 0.3;
    }
  }

  /** The dog's paws on the boards — much softer and rounder than human footsteps, and quicker. */
  private paws(ctx: AudioContext, out: AudioNode): void {
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < 5 + Math.floor(Math.random() * 4); i++) {
      this.click(ctx, out, at, 190 + Math.random() * 80, 0.035, 0.035);
      at += 0.16 + Math.random() * 0.05;
    }
  }

  /** A collar shake: a quick cluster of tiny bright transients — the tag against the buckle. */
  private jingle(ctx: AudioContext, out: AudioNode): void {
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < 6 + Math.floor(Math.random() * 5); i++) {
      this.ping(ctx, out, at, 2400 + Math.random() * 1600, 0.006 + Math.random() * 0.004);
      at += 0.045 + Math.random() * 0.04;
    }
  }

  /** One quiet bark — a short voiced burst with a fast pitch drop. Kept soft on purpose: this dog is
   *  across the room, and its rarity is set in LIFE_EVENTS, not here. */
  private bark(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.8;
    bp.frequency.setValueAtTime(620 + Math.random() * 120, t0);
    bp.frequency.exponentialRampToValueAtTime(320, t0 + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + 0.2);
  }

  /** Birdsong through the window, morning only (E2 spec §4): one bird, a short phrase of quick
   *  upward chirps. Sine glides, not noise — a chirp is pitched — and each phrase draws its own
   *  base pitch, count and pacing so no two mornings repeat. Soft: the window is closed. */
  private birds(ctx: AudioContext, out: AudioNode): void {
    const base = 2600 + Math.random() * 900;
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
      const f = base * (0.92 + Math.random() * 0.16);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, at);
      osc.frequency.exponentialRampToValueAtTime(f * (1.25 + Math.random() * 0.2), at + 0.06);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.0055 + Math.random() * 0.003, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
      osc.connect(g).connect(out);
      osc.start(at);
      osc.stop(at + 0.11);
      at += 0.13 + Math.random() * 0.22;
    }
  }

  /** Night air for the late shift (E2 spec §4): a distant cricket-ish pulse train — a few tremolo'd
   *  high pips, very quiet, very sparse. Deliberately under everything else: it is the sound of the
   *  building being empty around the one lit desk, not a nature documentary. */
  private nightair(ctx: AudioContext, out: AudioNode): void {
    const f = 3800 + Math.random() * 700;
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) {
      this.ping(ctx, out, at, f * (0.98 + Math.random() * 0.04), 0.0035 + Math.random() * 0.002);
      at += 0.07 + Math.random() * 0.04;
    }
  }

  /** One short filtered noise burst — the shared shape behind a keystroke and a mug on a desk. */
  private click(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    freq: number,
    gain: number,
    dur = 0.045,
  ): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 2.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(at);
    src.stop(at + dur + 0.03);
  }
}

/** Process-wide singleton, reached only through the `roomTone` façade in `sound.ts`. */
export const roomToneEngine = new RoomTone();
