import { describe, expect, it } from 'vitest';
import { HAIR_STYLE_COUNT, hairFor, hairStyleFor, hslToArgb, modeFor, officeToRig, skinFor, spriteKey } from './rig';
import type { OfficeNode, Pose } from './types';

function node(p: Partial<OfficeNode> = {}): OfficeNode {
  return {
    name: 'Ada',
    kind: 'human',
    presence: 'online',
    activity: 'online',
    state: null,
    color: 'hsl(200, 68%, 62%)',
    role: '',
    ...p,
  };
}
function pose(p: Partial<Pose> = {}): Pose {
  return { lx: 0, ly: 0, dir: 'S', small: false, carry: false, bubble: null, alpha: 1, moving: false, run: false, gesture: 0, gestureT: 0, ...p };
}

describe('hslToArgb', () => {
  it('converts hsl to #ffRRGGBB and darkens by lightness scale', () => {
    expect(hslToArgb('hsl(0, 100%, 50%)')).toBe('#ffff0000'); // pure red
    expect(hslToArgb('hsl(120, 100%, 50%)')).toBe('#ff00ff00'); // pure green
    // darkening lowers the channels
    const base = hslToArgb('hsl(200, 68%, 62%)');
    const dark = hslToArgb('hsl(200, 68%, 62%)', 0.72);
    expect(dark).not.toBe(base);
    expect(hslToArgb('not-a-color')).toBe('#ff000000');
  });
});

describe('skinFor', () => {
  it('is stable per name and within the swatch set', () => {
    expect(skinFor('Ada')).toBe(skinFor('Ada'));
    expect(skinFor('Ada')).toMatch(/^#ff[0-9a-f]{6}$/);
  });
});

describe('hairFor', () => {
  it('is stable per name and within the swatch set', () => {
    expect(hairFor('Ada')).toBe(hairFor('Ada'));
    expect(hairFor('Ada')).toMatch(/^#ff[0-9a-f]{6}$/);
  });
  it('is decorrelated from skin (salted hash) — not every name maps skin↔hair to the same index', () => {
    const names = ['Ada', 'Bo', 'Cy', 'Dev', 'Eli', 'Fen', 'Gus', 'Hana', 'Ivy', 'Jo'];
    const differ = names.filter((n) => skinFor(n) !== hairFor(n));
    expect(differ.length).toBeGreaterThan(0);
  });
});

describe('hairStyleFor', () => {
  it('is stable per name and within [0, HAIR_STYLE_COUNT)', () => {
    for (const n of ['Ada', 'Bo', 'Cyrus', 'Devi', 'Eli', 'Fen', 'Gus', 'Hana']) {
      const s = hairStyleFor(n);
      expect(s).toBe(hairStyleFor(n));
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(HAIR_STYLE_COUNT);
    }
  });
  it('spreads across more than one style over a set of names', () => {
    const styles = new Set(['Ada', 'Bo', 'Cy', 'Dev', 'Eli', 'Fen', 'Gus', 'Hana', 'Ivy', 'Jo'].map(hairStyleFor));
    expect(styles.size).toBeGreaterThan(1);
  });
});

describe('officeToRig hairColor + hairStyle', () => {
  it('emits a stable name-seeded hair tint and style index', () => {
    const r = officeToRig(node({ name: 'Ada' }), pose());
    expect(r.hairColor).toBe(hairFor('Ada'));
    expect(r.hairColor).toMatch(/^#ff[0-9a-f]{6}$/);
    expect(r.hairStyle).toBe(hairStyleFor('Ada'));
  });
});

describe('modeFor (priority away > help > walking > working > idle)', () => {
  it('away wins', () => expect(modeFor(node({ presence: 'away', activity: 'working' }), pose({ moving: true }))).toBe(3));
  it('help (bubble) next', () => expect(modeFor(node({ activity: 'working' }), pose({ bubble: '?', moving: true }))).toBe(4));
  it('walking next', () => expect(modeFor(node({ activity: 'working' }), pose({ moving: true }))).toBe(2));
  it('working next', () => expect(modeFor(node({ activity: 'working' }), pose())).toBe(1));
  it('idle default', () => expect(modeFor(node({ activity: 'online' }), pose())).toBe(0));
});

describe('spriteKey (idle sprite-cache invalidation)', () => {
  it('is stable for identical inputs (an unchanged seat blits its cache)', () => {
    const a = officeToRig(node({ name: 'Ada', activity: 'working' }), pose());
    const b = officeToRig(node({ name: 'Ada', activity: 'working' }), pose());
    expect(spriteKey(a)).toBe(spriteKey(b));
  });
  it('flips when an appearance-affecting input changes (facing, mode, carry, run)', () => {
    const base = officeToRig(node({ name: 'Ada', activity: 'working' }), pose());
    const turned = officeToRig(node({ name: 'Ada', activity: 'working' }), pose({ dir: 'E' }));
    const walking = officeToRig(node({ name: 'Ada', activity: 'working' }), pose({ moving: true }));
    const carrying = officeToRig(node({ name: 'Ada', activity: 'working' }), pose({ carry: true }));
    const running = officeToRig(node({ name: 'Ada' }), pose({ moving: true, run: true }));
    expect(spriteKey(turned)).not.toBe(spriteKey(base));
    expect(spriteKey(walking)).not.toBe(spriteKey(base));
    expect(spriteKey(carrying)).not.toBe(spriteKey(base));
    expect(spriteKey(running)).not.toBe(spriteKey(walking));
  });
  it('distinguishes members with different tints/tells (agent vs human, different names)', () => {
    const human = officeToRig(node({ name: 'Ada', kind: 'human' }), pose());
    const agent = officeToRig(node({ name: 'Ada', kind: 'agent' }), pose());
    const other = officeToRig(node({ name: 'Zed', kind: 'human' }), pose());
    expect(spriteKey(agent)).not.toBe(spriteKey(human)); // agentVis/humanVis differ
    expect(spriteKey(other)).not.toBe(spriteKey(human)); // name-seeded skin/hair differ
  });

  it('flips when an in-place gesture starts (so the cache re-renders while it plays)', () => {
    const idle = officeToRig(node({ name: 'Ada' }), pose({ gesture: 0 }));
    const stretch = officeToRig(node({ name: 'Ada' }), pose({ gesture: 1 }));
    const glance = officeToRig(node({ name: 'Ada' }), pose({ gesture: 2 }));
    expect(spriteKey(stretch)).not.toBe(spriteKey(idle));
    expect(spriteKey(glance)).not.toBe(spriteKey(stretch));
  });
});

describe('officeToRig gesture', () => {
  it('passes the pose gesture through to the rig input', () => {
    expect(officeToRig(node(), pose({ gesture: 0 })).gesture).toBe(0);
    expect(officeToRig(node(), pose({ gesture: 1 })).gesture).toBe(1);
    expect(officeToRig(node(), pose({ gesture: 2 })).gesture).toBe(2);
  });
});

describe('officeToRig', () => {
  it('maps a working human', () => {
    const r = officeToRig(node({ kind: 'human', activity: 'working' }), pose());
    expect(r.humanVis).toBe(1);
    expect(r.agentVis).toBe(0);
    expect(r.mode).toBe(1);
    expect(r.facing).toBe(0);
    expect(r.accentColor).toMatch(/^#ff/);
  });
  it('maps an agent carrying + running east', () => {
    const r = officeToRig(node({ kind: 'agent' }), pose({ dir: 'E', carry: true, moving: true, run: true }));
    expect(r.agentVis).toBe(1);
    expect(r.humanVis).toBe(0);
    expect(r.carryVis).toBe(1);
    expect(r.run).toBe(1);
    expect(r.facing).toBe(1);
    expect(r.mode).toBe(2); // walking
  });
});
