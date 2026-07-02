import { describe, expect, it } from 'vitest';
import { hairFor, hslToArgb, modeFor, officeToRig, skinFor } from './rig';
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
  return { lx: 0, ly: 0, dir: 'S', small: false, carry: false, bubble: null, alpha: 1, moving: false, run: false, ...p };
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

describe('officeToRig hairColor', () => {
  it('emits a stable name-seeded hair tint', () => {
    const r = officeToRig(node({ name: 'Ada' }), pose());
    expect(r.hairColor).toBe(hairFor('Ada'));
    expect(r.hairColor).toMatch(/^#ff[0-9a-f]{6}$/);
  });
});

describe('modeFor (priority away > help > walking > working > idle)', () => {
  it('away wins', () => expect(modeFor(node({ presence: 'away', activity: 'working' }), pose({ moving: true }))).toBe(3));
  it('help (bubble) next', () => expect(modeFor(node({ activity: 'working' }), pose({ bubble: '?', moving: true }))).toBe(4));
  it('walking next', () => expect(modeFor(node({ activity: 'working' }), pose({ moving: true }))).toBe(2));
  it('working next', () => expect(modeFor(node({ activity: 'working' }), pose())).toBe(1));
  it('idle default', () => expect(modeFor(node({ activity: 'online' }), pose())).toBe(0));
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
