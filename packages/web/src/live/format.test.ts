import { describe, expect, it } from 'vitest';
import { toneColor } from './office-scene/render';
import { actLabel, actTone } from './format';

describe('actTone — steering acts (ADR 103)', () => {
  it('gives steer and challenge their own prominent tones, and defer the lane family', () => {
    expect(actTone('steer')).toBe('steer');
    expect(actTone('challenge')).toBe('challenge');
    // defer mutates a Goal on the plan → rides the same lane (work-moving) family as lane transitions.
    expect(actTone('defer')).toBe('lane');
    expect(actTone('lane_open')).toBe('lane');
  });

  it('leaves the pre-existing acts untouched', () => {
    expect(actTone('request_help')).toBe('accent');
    expect(actTone('resolve')).toBe('success');
    expect(actTone('handoff')).toBe('handoff');
    expect(actTone('nope')).toBe('neutral');
  });
});

describe('actLabel — steering acts', () => {
  it('reads the steering acts verbatim (already clean single words)', () => {
    expect(actLabel('steer')).toBe('steer');
    expect(actLabel('challenge')).toBe('challenge');
    expect(actLabel('defer')).toBe('defer');
  });
});

describe('toneColor — office palette mirrors the CSS tokens', () => {
  it('resolves every act tone to a concrete colour (no steering/lane tone falls through to default)', () => {
    const defaultColor = toneColor('neutral');
    for (const tone of ['steer', 'challenge', 'lane', 'handoff', 'status', 'accent', 'success']) {
      expect(toneColor(tone)).not.toBe(defaultColor);
    }
  });
});
