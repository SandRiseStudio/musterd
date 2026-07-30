// Firehose sound — a tiny WebAudio synth that gives every live act its own short, musical cue.
//
// No audio assets: each act is a handful of scheduled oscillator notes drawn from a consonant
// pentatonic set, so even a burst of simultaneous arrivals stays pleasant rather than noisy. The
// engine is opt-in (default OFF) and only ever builds its AudioContext from the enabling click, which
// is what browser autoplay policy requires. SSR-safe: nothing touches `window`/AudioContext until a
// browser actually enables it.

const PREF_KEY = 'musterd.live.sound';

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

class FirehoseSound {
  enabled = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      try {
        this.enabled = window.localStorage.getItem(PREF_KEY) === '1';
      } catch {
        this.enabled = false;
      }
    }
  }

  /** Toggle sound. Enabling must come from a user gesture so the AudioContext can start. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      window.localStorage.setItem(PREF_KEY, on ? '1' : '0');
    } catch {
      /* private mode / disabled storage — fine, just don't persist */
    }
    if (on) this.ensureContext();
  }

  private ensureContext(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      // master bus → gentle lowpass for warmth → speakers
      const master = this.ctx.createGain();
      master.gain.value = 0.85;
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

/** Process-wide singleton — the toggle writes it, the stream hook reads it. */
export const firehoseSound = new FirehoseSound();

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

const ROOM_PREF_KEY = 'musterd.live.roomtone';
/** Ceiling on the whole bed. Low enough to sit under a podcast, loud enough to miss when it stops. */
const ROOM_GAIN = 0.075;
/** Gap between sparse events, seconds. Wide, and jittered inside the window — an office you can set
 *  your watch by is a metronome, and the ear finds a metronome within about two cycles. */
const LIFE_GAP: [number, number] = [2.5, 8];
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
 * a fresh random noise buffer, and the peak of a narrowband noise burst wanders that much. A control
 * sweep confirmed the harness itself tracks gain at ~6 dB per doubling, so differences of that order
 * are real and anything smaller is not. Do not tune this layer to a finer resolution than that.
 */
const LIFE_GAIN = 34;

class RoomTone {
  enabled = false;
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  /** The LIFE layer's own bus (see `LIFE_GAIN`) — sparse events land here, never straight on `bus`. */
  private lifeBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watching = false;

  constructor() {
    if (typeof window !== 'undefined') {
      try {
        this.enabled = window.localStorage.getItem(ROOM_PREF_KEY) === '1';
      } catch {
        this.enabled = false;
      }
    }
  }

  /** Toggle the bed. Enabling must come from a user gesture so the AudioContext can start. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      window.localStorage.setItem(ROOM_PREF_KEY, on ? '1' : '0');
    } catch {
      /* private mode / disabled storage — fine, just don't persist */
    }
    if (on) this.start();
    else this.stop();
  }

  /**
   * A preference that survives a reload cannot legally resume itself — the page has had no gesture
   * yet, so the context would be born suspended. `resumeIfEnabled` is what the *first* interaction
   * calls: if the viewer already asked for room tone in an earlier session, this is where it actually
   * starts. No gesture ever arrives → nothing ever plays, which is the correct outcome, not a bug.
   */
  resumeIfEnabled(): void {
    if (this.enabled) this.start();
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
    bus.gain.exponentialRampToValueAtTime(ROOM_GAIN, ctx.currentTime + 1.5);
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
    if (!this.watching) {
      this.watching = true;
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    // `visibilitychange` only fires on a CHANGE, so the listener alone never catches the case where
    // the tab is *already* hidden when the bed starts — a preference restored on a background tab,
    // or a viewer who switched away between the click and the context opening. Check the state we
    // are actually in, rather than waiting for it to be announced.
    if (document.hidden) void ctx.suspend();
  }

  private onVisibility = (): void => {
    if (!this.ctx || !this.enabled) return;
    if (document.hidden) void this.ctx.suspend();
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

  /** Schedule the next sparse event, and re-arm from it. One timer, always. */
  private armLife(): void {
    clearTimeout(this.timer);
    const wait = LIFE_GAP[0] + Math.random() * (LIFE_GAP[1] - LIFE_GAP[0]);
    this.timer = setTimeout(() => {
      if (this.bus && this.ctx?.state === 'running' && !document.hidden) this.life();
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
    const pan = ctx.createStereoPanner?.();
    const out = pan ?? ctx.createGain();
    if (pan) pan.pan.value = (Math.random() * 2 - 1) * 0.75;
    out.connect(bus);
    // Long enough for the longest murmur or typing run to finish before its channel goes away.
    setTimeout(() => out.disconnect(), 9000);

    // The mix leans on the sounds of *work* — typing and talk — with the object noises and the rare
    // chat-app ping as seasoning. Every branch below jitters its own parameters, so even the same
    // event twice in a row never plays the same twice (nick, 2026-07-29: "very dynamic and variable
    // so they don't get old").
    const roll = Math.random();
    if (roll < 0.34) this.keys(ctx, out);
    else if (roll < 0.54) this.murmur(ctx, out);
    else if (roll < 0.68) this.tap(ctx, out, 0.9);
    else if (roll < 0.8) this.creak(ctx, out);
    else if (roll < 0.9) this.chime(ctx, out);
    else this.tap(ctx, out, 0.35);
  }

  /** Somebody typing, a few desks away: a run of clicks at a human, uneven rate. Sometimes a quick
   *  flurry, sometimes a long thought typed out — with a thinking pause in the middle of the long
   *  ones. A uniform run is what the ear learns first. */
  private keys(ctx: AudioContext, out: AudioNode): void {
    const long = Math.random() < 0.3;
    const n = long ? 14 + Math.floor(Math.random() * 12) : 4 + Math.floor(Math.random() * 9);
    const pauseAt = long ? 5 + Math.floor(Math.random() * (n - 8)) : -1;
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < n; i++) {
      this.click(ctx, out, at, 1650 + Math.random() * 900, 0.05 + Math.random() * 0.04);
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
  private murmur(ctx: AudioContext, out: AudioNode): void {
    let at = ctx.currentTime + 0.05;
    const phrases = 2 + Math.floor(Math.random() * 2);
    for (let ph = 0; ph < phrases; ph++) {
      // alternate speakers: one higher register, one lower
      // Formant centre, not vocal-fold pitch: what carries through a room is the resonance band
      // around 300–650 Hz, and centring the band on a 130 Hz fundamental put nearly all the energy
      // below where the muffling lowpass could shape it (it was also the quietest event by 17 dB).
      // Two registers, an upper and a lower speaker, so an exchange has two people in it.
      const voice = ph % 2 === 0 ? 460 + Math.random() * 190 : 310 + Math.random() * 130;
      const syllables = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < syllables; i++) {
        const dur = 0.09 + Math.random() * 0.11;
        this.voiceBurst(ctx, out, at, voice * (0.9 + Math.random() * 0.35), dur);
        at += dur + 0.02 + Math.random() * 0.06;
      }
      at += 0.25 + Math.random() * 0.55; // the beat where the other one answers
    }
  }

  /** One spoken syllable, heard through the room: a noise burst through a gliding bandpass (the pitch
   *  contour of speech) then a hard lowpass (the wall between you and the words). */
  private voiceBurst(ctx: AudioContext, out: AudioNode, at: number, freq: number, dur: number): void {
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
    g.gain.exponentialRampToValueAtTime(0.075 + Math.random() * 0.028, at + dur * 0.35);
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

/** Process-wide singleton — the room-tone toggle owns it; nothing else needs to touch it. */
export const roomTone = new RoomTone();
