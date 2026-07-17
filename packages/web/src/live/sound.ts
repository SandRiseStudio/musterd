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
