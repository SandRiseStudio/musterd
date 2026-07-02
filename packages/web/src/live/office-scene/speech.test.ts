import { describe, expect, it } from 'vitest';
import { truncateSpeech, typeCadence } from './speech';

describe('truncateSpeech', () => {
  it('passes short text through, collapsing whitespace', () => {
    expect(truncateSpeech('hello   there\nfriend')).toBe('hello there friend');
  });
  it('cuts long text on a word boundary with an ellipsis', () => {
    const out = truncateSpeech('the quick brown fox jumps over the lazy dog and keeps on running along', 30);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out).not.toMatch(/\s…$/); // no dangling space before the ellipsis
  });
  it('hard-cuts a single very long word (no early boundary)', () => {
    const out = truncateSpeech('supercalifragilisticexpialidocious', 10);
    expect(out).toBe('supercalif…');
  });
});

describe('typeCadence', () => {
  it('is clamped to a comfortable per-char range', () => {
    expect(typeCadence(1)).toBe(55); // very short → slowest allowed
    expect(typeCadence(1000)).toBe(18); // very long → fastest allowed
    const mid = typeCadence(50);
    expect(mid).toBeGreaterThanOrEqual(18);
    expect(mid).toBeLessThanOrEqual(55);
  });
});
