import { describe, expect, it } from 'vitest';
import {
  FULL_MAX,
  GLANCE_MAX,
  GLANCE_MAX_STATUS,
  shapeSpeech,
  stripNoise,
  truncateSpeech,
  typeCadence,
} from './speech';

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
  it('prefers a sentence boundary when one lands deep in the window', () => {
    const out = truncateSpeech('The deploy is green and the suite passed. Opening the PR now.', 50);
    expect(out).toBe('The deploy is green and the suite passed.'); // whole sentence, no ellipsis
  });
});

describe('stripNoise', () => {
  it('strips markdown headers, emphasis, and inline code', () => {
    expect(stripNoise('## Title\n**bold** and _em_ and `code`')).toBe('Title bold and em and code');
  });
  it('collapses a fenced code block to a compact token', () => {
    expect(stripNoise('before\n```ts\nconst x = 1;\n```\nafter')).toBe('before ⟨code⟩ after');
  });
  it('reduces a bare URL to an arrow + hostname', () => {
    expect(stripNoise('see https://github.com/foo/bar/pull/9 now')).toBe('see ↗ github.com now');
  });
  it('keeps a markdown link label, drops the target', () => {
    expect(stripNoise('open the [PR](https://github.com/x) please')).toBe('open the PR please');
  });
  it('drops leading list bullets and blockquotes', () => {
    expect(stripNoise('- one\n- two\n> quoted')).toBe('one two quoted');
  });
});

describe('shapeSpeech', () => {
  it('shapes a short line into an unclamped glance == full', () => {
    const s = shapeSpeech('on it — checking the deploy');
    expect(s.glance).toBe('on it — checking the deploy');
    expect(s.full).toBe(s.glance);
    expect(s.clamped).toBe(false);
  });
  it('clamps a long body: glance shorter than full, clamped flag set', () => {
    const raw = 'x'.repeat(400);
    const s = shapeSpeech(raw);
    expect(s.glance.length).toBeLessThanOrEqual(GLANCE_MAX + 1);
    expect(s.clamped).toBe(true);
    expect(s.full.length).toBeGreaterThan(s.glance.length);
  });
  it('gives status_update a tighter glance budget', () => {
    const raw = 'word '.repeat(60).trim();
    const status = shapeSpeech(raw, 'status_update');
    const message = shapeSpeech(raw, 'message');
    expect(status.glance.length).toBeLessThanOrEqual(GLANCE_MAX_STATUS + 1);
    expect(message.glance.length).toBeGreaterThan(status.glance.length);
  });
  it('caps full text at FULL_MAX', () => {
    const s = shapeSpeech('y'.repeat(FULL_MAX + 500));
    expect(s.full.length).toBeLessThanOrEqual(FULL_MAX + 1);
  });
  it('passes a body-less act label through untouched', () => {
    const s = shapeSpeech('accepted the handoff');
    expect(s.glance).toBe('accepted the handoff');
    expect(s.clamped).toBe(false);
  });
});

describe('typeCadence', () => {
  it('is clamped to a comfortable per-char range', () => {
    expect(typeCadence(1)).toBe(55); // very short → slowest allowed
    expect(typeCadence(1000)).toBe(16); // very long → fastest allowed
    const mid = typeCadence(50);
    expect(mid).toBeGreaterThanOrEqual(16);
    expect(mid).toBeLessThanOrEqual(55);
  });
  it('types a full glance in roughly three seconds', () => {
    const total = GLANCE_MAX * typeCadence(GLANCE_MAX);
    expect(total).toBeGreaterThan(2200);
    expect(total).toBeLessThan(3800);
  });
});
