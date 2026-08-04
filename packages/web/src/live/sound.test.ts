import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_LIFE,
  firehoseSound,
  roomTone,
  keyboardFor,
  keypressPlan,
  LIFE_EVENTS,
  type LifeContext,
  panFor,
  pickLifeEvent,
} from './sound';

// These tests cover the parts of the room-tone layer that are LOGIC — which event fires, under what
// gate, with what pan. The levels are deliberately not unit-tested: they are verified by offline
// render through the calibration graph documented in sound.ts, whose ±3 dB resolution no assertion
// can hold meaningfully.

const near: LifeContext = { pairs: [{ x: 0.3 }], dog: null };
const withDog: LifeContext = { pairs: [], dog: { x: -0.4, walking: true } };
const dogResting: LifeContext = { pairs: [], dog: { x: -0.4, walking: false } };

/** Every event the roll can produce for a context, swept finely across [0, 1). */
function sweep(ctx: LifeContext): Set<string> {
  const out = new Set<string>();
  for (let r = 0; r < 1; r += 0.001) out.add(pickLifeEvent(r, ctx));
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

describe('enableForBroadcast (ADR 226)', () => {
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
