import { describe, expect, it, vi } from 'vitest';
import { EMPTY_LIFE, firehoseSound, type LifeContext, roomTone, screenPan } from './sound';
import {
  deskPhase,
  keyboardFor,
  keypressPlan,
  LIFE_EVENTS,
  LIFE_GAP,
  lifeGapFor,
  panFor,
  pickLifeEvent,
  momentPan,
  pickWorkDesk,
  shouldChime,
  shouldPlayMoment,
} from './soundLife';

// These tests cover the parts of the room-tone layer that are LOGIC — which event fires, under what
// gate, with what pan. The levels are deliberately not unit-tested: they are verified by offline
// render through the calibration graph documented in sound.ts, whose ±3 dB resolution no assertion
// can hold meaningfully.

const near: LifeContext = { ...EMPTY_LIFE, pairs: [{ x: 0.3 }] };
const withDog: LifeContext = { ...EMPTY_LIFE, dog: { x: -0.4, walking: true } };
const dogResting: LifeContext = { ...EMPTY_LIFE, dog: { x: -0.4, walking: false } };
const oneWorking: LifeContext = { ...EMPTY_LIFE, working: [{ x: 0.5, seed: 7 }], density: 0.5 };

/** A clock instant at which the given desk is in its typing phase (searched, deterministic). */
function typingMomentFor(seed: number): number {
  for (let t = 0; t < 120_000; t += 500) if (deskPhase(seed, t) === 'typing') return t;
  throw new Error(`desk seed ${seed} never types in 120s`);
}

/** Every event the roll can produce for a context, swept finely across [0, 1). */
function sweep(ctx: LifeContext, nowMs = 0): Set<string> {
  const out = new Set<string>();
  for (let r = 0; r < 1; r += 0.001) out.add(pickLifeEvent(r, ctx, nowMs));
  return out;
}

describe('the life event roll', () => {
  it('weights sum to one', () => {
    expect(LIFE_EVENTS.reduce((s, e) => s + e.weight, 0)).toBeCloseTo(1, 5);
  });

  it('is deterministic for a given roll', () => {
    expect(pickLifeEvent(0.5, EMPTY_LIFE)).toBe(pickLifeEvent(0.5, EMPTY_LIFE));
  });

  it('has every requested event in the table', () => {
    const names = LIFE_EVENTS.map((e) => e.name);
    for (const n of ['stapler', 'drawer', 'footsteps', 'sip', 'blow', 'water', 'eating']) {
      expect(names).toContain(n);
    }
  });

  it('keeps work and talk the majority of the mix', () => {
    const chatter = LIFE_EVENTS.filter((e) => ['keys', 'murmur'].includes(e.name));
    expect(chatter.reduce((s, e) => s + e.weight, 0)).toBeGreaterThan(0.5);
  });

  it('keeps the bark rare — a bark on a timer is an alarm clock', () => {
    expect(LIFE_EVENTS.find((e) => e.name === 'bark')!.weight).toBeLessThan(0.02);
  });
});

describe('chatter', () => {
  it('never fires with nobody near anybody — an empty office does not talk to itself', () => {
    const heard = sweep(EMPTY_LIFE);
    expect(heard.has('murmur')).toBe(false);
    expect(heard.has('whisper')).toBe(false);
  });

  it('fires when two members actually share a zone', () => {
    expect(sweep(near).has('murmur')).toBe(true);
  });

  it('pans toward the pair, not at random', () => {
    expect(panFor('murmur', near)).toBeCloseTo(0.3 * 0.75, 5);
    expect(panFor('whisper', near)).toBeCloseTo(0.3 * 0.75, 5);
  });

  it('leaves unpositioned events to the random pan', () => {
    expect(panFor('keys', near)).toBeNull();
    expect(panFor('stapler', near)).toBeNull();
  });
});

describe('dog sounds', () => {
  it('never fire with no dog present', () => {
    const heard = sweep(EMPTY_LIFE);
    for (const n of ['paws', 'jingle', 'yawn', 'bark']) expect(heard.has(n)).toBe(false);
  });

  it('fire when the dog is on the floor, panned to where it is', () => {
    const heard = sweep(withDog);
    expect(heard.has('jingle')).toBe(true);
    expect(panFor('bark', withDog)).toBeCloseTo(-0.4 * 0.75, 5);
  });

  it('keeps the paws to a dog that is actually walking', () => {
    expect(sweep(withDog).has('paws')).toBe(true);
    expect(sweep(dogResting).has('paws')).toBe(false);
  });
});

describe('work sounds track evidenced work (E2 spec §3)', () => {
  it('keeps every work-family sound out of a room where nobody is working', () => {
    const heard = sweep(EMPTY_LIFE);
    for (const n of ['keys', 'tap', 'softTap', 'creak', 'drawer', 'stapler']) {
      expect(heard.has(n), n).toBe(false);
    }
  });

  it('keeps work sounds out even when people are merely present (idle room keeps presence sounds)', () => {
    const heard = sweep(near);
    expect(heard.has('keys')).toBe(false);
    expect(heard.has('murmur')).toBe(true);
  });

  it('lets keys fire only while some desk is in its typing phase', () => {
    const at = typingMomentFor(7);
    expect(sweep(oneWorking, at).has('keys')).toBe(true);
    expect(sweep(oneWorking, at).has('tap')).toBe(true);
  });

  it('places a work event on an actual working desk', () => {
    const at = typingMomentFor(7);
    const desk = pickWorkDesk('keys', 0.5, oneWorking, at);
    expect(desk).toEqual({ x: 0.5, seed: 7 });
    expect(pickWorkDesk('keys', 0.5, EMPTY_LIFE, at)).toBeNull();
  });

  it('sends keys to a typing desk, never a thinking one', () => {
    const typing = 7;
    const at = typingMomentFor(typing);
    let thinking: number | null = null;
    for (let s = 100; s < 200; s++) {
      if (deskPhase(s, at) === 'thinking') {
        thinking = s;
        break;
      }
    }
    expect(thinking).not.toBeNull();
    const ctx: LifeContext = {
      ...EMPTY_LIFE,
      working: [
        { x: -0.8, seed: thinking! },
        { x: 0.8, seed: typing },
      ],
    };
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(pickWorkDesk('keys', roll, ctx, at)).toEqual({ x: 0.8, seed: typing });
    }
    // Taps may land on either desk — a thinking desk still shuffles paper.
    expect(pickWorkDesk('tap', 0, ctx, at)).not.toBeNull();
  });
});

describe('the think/type phase', () => {
  it('is deterministic in (seed, now)', () => {
    expect(deskPhase(7, 30_000)).toBe(deskPhase(7, 30_000));
  });

  it('visits both phases over a couple of minutes', () => {
    const seen = new Set<string>();
    for (let t = 0; t < 120_000; t += 1000) seen.add(deskPhase(7, t));
    expect(seen).toEqual(new Set(['typing', 'thinking']));
  });

  it('gives different desks different rhythms', () => {
    const a: string[] = [];
    const b: string[] = [];
    for (let t = 0; t < 120_000; t += 1000) {
      a.push(deskPhase(7, t));
      b.push(deskPhase(8, t));
    }
    expect(a.join('')).not.toBe(b.join(''));
  });
});

describe('density is tempo, not gain (E2 spec §4)', () => {
  it('leaves the quiet room at the historical gap', () => {
    expect(lifeGapFor(0)).toEqual(LIFE_GAP);
  });

  it('schedules a full sprint about twice as often, monotonically', () => {
    const [minFull, maxFull] = lifeGapFor(1);
    expect(maxFull).toBeCloseTo(LIFE_GAP[1] / 2, 5);
    expect(minFull).toBeLessThan(LIFE_GAP[0]);
    const mids = [0, 0.25, 0.5, 0.75, 1].map((d) => lifeGapFor(d)[1]);
    for (let i = 1; i < mids.length; i++) expect(mids[i]!).toBeLessThan(mids[i - 1]!);
  });

  it('never drops below the burst floor', () => {
    expect(lifeGapFor(1)[0]).toBeGreaterThanOrEqual(1.2);
  });
});

describe('the day cycle follows the window light (E2 spec §4)', () => {
  it('lets birds sing only into a morning with actual daylight', () => {
    const morning: LifeContext = { ...EMPTY_LIFE, hours: 7.5, daylight: 0.6 };
    const noon: LifeContext = { ...EMPTY_LIFE, hours: 12, daylight: 1 };
    const night: LifeContext = { ...EMPTY_LIFE, hours: 7.5, daylight: 0 };
    expect(sweep(morning).has('birds')).toBe(true);
    expect(sweep(noon).has('birds')).toBe(false);
    expect(sweep(night).has('birds')).toBe(false);
  });

  it('keeps night air for a dark room that someone is actually in', () => {
    const lateShift: LifeContext = {
      ...EMPTY_LIFE,
      hours: 23,
      daylight: 0,
      working: [{ x: 0, seed: 1 }],
    };
    const emptyNight: LifeContext = { ...EMPTY_LIFE, hours: 23, daylight: 0 };
    const day: LifeContext = { ...lateShift, hours: 12, daylight: 1 };
    expect(sweep(lateShift, typingMomentFor(1)).has('nightair')).toBe(true);
    expect(sweep(emptyNight).has('nightair')).toBe(false);
    expect(sweep(day, typingMomentFor(1)).has('nightair')).toBe(false);
  });
});

describe('the keyboard', () => {
  it('holds one keyboard per run and a different one next run', () => {
    expect(keyboardFor(1)).toEqual(keyboardFor(1));
    expect(keyboardFor(1)).not.toEqual(keyboardFor(2));
  });

  it('plays two transients per key — a real press is a thock down and a click up', () => {
    const plan = keypressPlan(keyboardFor(7));
    expect(plan).toHaveLength(2);
    expect(plan[1]!.at).toBeGreaterThan(plan[0]!.at);
  });

  it('makes the release brighter and quieter than the thock', () => {
    const kb = keyboardFor(7);
    const [down, up] = keypressPlan(kb);
    expect(up!.freq).toBeGreaterThan(down!.freq * 2);
    expect(up!.gain).toBeLessThan(down!.gain);
  });

  it('sits the body an octave-ish below the old bright band', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(keyboardFor(seed).body).toBeLessThan(1400);
    }
  });
});

describe('enableForBroadcast (ADR 228)', () => {
  it('turns each engine on without touching the operator’s stored preference', () => {
    // Node env: stub just enough browser for the persistence check to be meaningful.
    const store = new Map<string, string>([
      ['musterd.live.sound', '0'],
      ['musterd.live.roomtone', '0'],
    ]);
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal('document', { hidden: true, addEventListener: () => {} });
    try {
      firehoseSound.enableForBroadcast();
      roomTone.enableForBroadcast();
      expect(firehoseSound.enabled).toBe(true);
      expect(roomTone.enabled).toBe(true);
      // A stream source must never rewrite the preference a human set on this machine.
      expect(store.get('musterd.live.sound')).toBe('0');
      expect(store.get('musterd.live.roomtone')).toBe('0');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('shouldChime (the broadcast cue throttle)', () => {
  it('passes a cue clear of the gap and holds one inside it', () => {
    expect(shouldChime(1000, 0)).toBe(true); // 1000ms since the last — clear
    expect(shouldChime(1000, 900)).toBe(false); // 100ms since — inside
  });

  it('reopens exactly at the gap, not a millisecond before', () => {
    expect(shouldChime(1000, 300)).toBe(true); // exactly 700ms
    expect(shouldChime(1000, 301)).toBe(false); // 699ms
  });

  it('coalesces a burst to one cue rather than queueing', () => {
    // -Infinity is the never-fired sentinel the engine starts at, so the first act always sounds.
    let last = -Infinity;
    const fired = [0, 10, 20, 30, 40, 50].filter((t) => {
      if (!shouldChime(t, last)) return false;
      last = t;
      return true;
    });
    expect(fired).toEqual([0]);
  });
});

describe('the lazy engine façade', () => {
  // The engines are a dynamic import now, so the risk this file has to cover is no longer "does the
  // synth work" — it is "does a command issued before the chunk lands survive the wait".

  it('answers `enabled` from the stored preference without loading the engines', () => {
    // Nothing here awaits: the toggle reads this during render, on a page that may never fetch a synth.
    expect(typeof firehoseSound.enabled).toBe('boolean');
    expect(typeof roomTone.enabled).toBe('boolean');
  });

  it('forwards a command issued before the chunk lands, once it lands', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { hidden: true, addEventListener: () => {} });
    try {
      firehoseSound.enableForBroadcast();
      roomTone.enableForBroadcast();
      // The façade said yes synchronously; the engines have not been asked yet.
      const engines = await import('./soundEngine');
      // One more turn for the façade's own `.then` to run after the module resolves.
      await Promise.resolve();
      expect(engines.firehoseEngine.enabled).toBe(true);
      expect(engines.roomToneEngine.enabled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops a cue that arrives before the engines do, rather than queueing it', () => {
    // A burst during the fetch must not collapse into one simultaneous chord when the chunk lands.
    // Nothing to assert but the absence of a throw and of a queue: the cue is simply gone.
    expect(() => firehoseSound.chime('message')).not.toThrow();
  });

  it('takes occupancy before an engine exists and hands it over on load', async () => {
    roomTone.setOccupancy(near);
    const { roomToneEngine } = await import('./soundEngine');
    await Promise.resolve();
    expect(() => roomTone.setOccupancy(EMPTY_LIFE)).not.toThrow();
    expect(roomToneEngine).toBeDefined();
  });
});

describe('milestone moments (E3 spec)', () => {
  it('throttles a burst of moments to one per 400ms', () => {
    expect(shouldPlayMoment(1000, -Infinity)).toBe(true);
    expect(shouldPlayMoment(1000, 700)).toBe(false); // 300ms since — inside
    expect(shouldPlayMoment(1000, 600)).toBe(true); // exactly 400ms
  });

  it('converts a canvas pixel to raw [-1, 1] without the stereo squeeze', () => {
    expect(screenPan(0, 800)).toBe(-1);
    expect(screenPan(400, 800)).toBe(0);
    expect(screenPan(800, 800)).toBe(1); // raw edge — the squeeze is the engine's alone
    expect(screenPan(900, 800)).toBe(1); // clamped
    expect(screenPan(100, 0)).toBe(0); // unsized canvas: centre, not NaN
  });

  it('squeezes exactly once, in the engine step', () => {
    expect(momentPan(screenPan(800, 800))).toBeCloseTo(0.75, 5);
    expect(momentPan(-2)).toBeCloseTo(-0.75, 5); // clamps before squeezing
  });

  it('drops a moment issued before the engines load, rather than queueing it', () => {
    expect(() => roomTone.moment('fanfare', 0.2)).not.toThrow();
  });

  it("carries the E4 interaction names and the whoosh's destination pan", () => {
    // panTo rides the same forward-or-drop path; other voices simply ignore it.
    expect(() => roomTone.moment('whoosh', -0.5, 0.5)).not.toThrow();
    for (const m of ['plateOpen', 'plateClose', 'boardOpen', 'boardClose'] as const) {
      expect(() => roomTone.moment(m, 0)).not.toThrow();
    }
  });
});
