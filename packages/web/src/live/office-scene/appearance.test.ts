import { describe, expect, it } from 'vitest';
import { appearanceOf, type Appearance } from './appearance';

/**
 * The wardrobe's contract. The point of the whole module is that a floor of members looks like a room of
 * *people* — so what's worth pinning is variety, independence, and the one thing that must NOT vary.
 */

const agent = (name: string) => appearanceOf({ name, kind: 'agent' as const });
const human = (name: string) => appearanceOf({ name, kind: 'human' as const });

/** A realistic spread of names, to sample the distribution the way a real roster would. */
const NAMES = [
  'miley', 'izzo', 'stanley', 'ryder', 'nick', 'ada', 'bo', 'cy', 'dev', 'eli',
  'fen', 'gus', 'hana', 'ivy', 'jo', 'kit', 'lu', 'mo', 'nia', 'ola',
  'pax', 'quinn', 'rex', 'sol', 'tay', 'uma', 'vic', 'wren', 'xan', 'yuki',
];

describe('determinism', () => {
  it('is stable per name — a teammate looks the same across frames, reloads, and machines', () => {
    expect(agent('miley')).toEqual(agent('miley'));
    expect(human('nick')).toEqual(human('nick'));
  });

  it('differs between people', () => {
    const looks = NAMES.map((n) => JSON.stringify(agent(n)));
    expect(new Set(looks).size).toBeGreaterThan(NAMES.length * 0.9);
  });
});

describe('variety', () => {
  const looks = NAMES.map(human);
  const spread = (key: keyof Appearance) => new Set(looks.map((l) => String(l[key]))).size;

  it('varies skin, hair, hair colour, trousers and shoes across a roster', () => {
    expect(spread('skin')).toBeGreaterThan(6);
    expect(spread('hair')).toBeGreaterThan(4);
    expect(spread('hairColor')).toBeGreaterThan(5);
    expect(spread('bottom')).toBeGreaterThan(4);
    expect(spread('shoes')).toBeGreaterThan(3);
    expect(spread('cut')).toBeGreaterThan(2);
  });

  it('lets people be bald, and lets some go bare-armed', () => {
    expect(looks.some((l) => l.hair === 'bald')).toBe(true);
    expect(looks.some((l) => l.bareArms)).toBe(true);
    expect(looks.some((l) => !l.bareArms)).toBe(true);
  });

  it('keeps hats and facial hair *rare* — a floor where everyone has one is as uniform as none', () => {
    const hatted = looks.filter((l) => l.hat !== 'none').length / looks.length;
    const bearded = looks.filter((l) => l.facialHair !== 'none').length / looks.length;
    expect(hatted).toBeGreaterThan(0);
    expect(hatted).toBeLessThan(0.55);
    expect(bearded).toBeGreaterThan(0);
    expect(bearded).toBeLessThan(0.7);
  });

  it('gives accessories (the per-person quirk) to some but keeps them rare, and varies the smile', () => {
    const accessorised = looks.filter((l) => l.accessory !== 'none').length / looks.length;
    expect(accessorised).toBeGreaterThan(0);
    expect(accessorised).toBeLessThan(0.6);
    // more than one kind of accessory shows up across the roster
    expect(new Set(looks.map((l) => l.accessory)).size).toBeGreaterThan(2);
    // both smile widths are present
    expect(new Set(looks.map((l) => l.smile)).size).toBe(2);
  });

  it('never gives anyone hair that vanishes into their skin', () => {
    // With a full-rainbow skin palette, an independent hair pick eventually puts green hair on a green
    // head — which at 30px is not a person, it is a blob. (This shipped once; the sheet caught it.)
    const luma = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    };
    for (const n of NAMES) {
      const l = human(n);
      if (l.hair === 'bald') continue;
      expect(Math.abs(luma(l.hairColor) - luma(l.skin))).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('picks each trait independently — hair colour must not correlate with skin', () => {
    // If two traits shared a salt they would move together; a shared stream would show up as the same
    // members always pairing the same two values.
    const pairs = new Set(NAMES.map((n) => `${human(n).skin}|${human(n).hairColor}`));
    const skins = new Set(NAMES.map((n) => human(n).skin));
    expect(pairs.size).toBeGreaterThan(skins.size);
  });
});

describe('the identity read (load-bearing)', () => {
  it('never puts a colour on the top — the top is the member colour, and that is how you know who it is', () => {
    // `Appearance` deliberately has no top-hue field. If one is ever added, the roster dot, the label and
    // the desk all stop agreeing with the body, and you can no longer pick a member out of the floor.
    expect(Object.keys(agent('miley'))).not.toContain('top');
    expect(Object.keys(agent('miley'))).not.toContain('topColor');
  });

  it('keeps the agent tell intact — no agent gets facial hair under its visor', () => {
    for (const n of NAMES) expect(agent(n).facialHair).toBe('none');
    // ...and humans do get it, so the absence is a tell rather than an oversight.
    expect(NAMES.some((n) => human(n).facialHair !== 'none')).toBe(true);
  });

  it('never puts glasses on an agent — a visor has nowhere for them to sit (like facial hair)', () => {
    for (const n of NAMES) expect(agent(n).accessory).not.toBe('glasses');
    // ...but humans do wear them, so the absence is a rule rather than a dead feature.
    expect(NAMES.some((n) => human(n).accessory === 'glasses')).toBe(true);
  });

  it('dresses the same person the same way whichever kind they are, apart from the tell', () => {
    const a = agent('sol');
    const h = human('sol');
    expect(a.skin).toBe(h.skin);
    expect(a.hair).toBe(h.hair);
    expect(a.cut).toBe(h.cut);
  });
});
