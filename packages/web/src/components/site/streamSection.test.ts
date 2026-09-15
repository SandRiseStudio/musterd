import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = () => readFileSync(fileURLToPath(new URL('./StreamSection.tsx', import.meta.url)), 'utf8');

/**
 * Source assertions (the repo has no DOM/hydration rig — see broadcast.stage.test.ts for the
 * pattern and the hydration incident these rules come from). The property under test: the
 * prerendered landing page owes Twitch nothing — the iframe exists only after an
 * IntersectionObserver, running in an effect on the client, says the section is visible.
 */
describe('the stream embed is deferred', () => {
  it('first render is the facade: visibility state seeds false', () => {
    expect(src()).toMatch(/useState\(false\)/);
  });

  it('the iframe renders only behind the visibility flag', () => {
    const s = src();
    const iframeAt = s.indexOf('<iframe');
    expect(iframeAt).toBeGreaterThan(-1);
    expect(s.slice(0, iframeAt)).toMatch(/visible\s*\?|\{visible &&/);
  });

  it('an IntersectionObserver flips it, and is disconnected after', () => {
    expect(src()).toContain('IntersectionObserver');
    expect(src()).toMatch(/\.disconnect\(\)/);
  });

  it('parent comes from location.hostname so previews work', () => {
    expect(src()).toContain('location.hostname');
  });

  it('does not pre-inject off-screen: Twitch refuses autoplay unless the player is in view', () => {
    // A rootMargin here would load the player before it is visible; Twitch then logs
    // "Autoplay disabled … viewport visibility" and the embed never counts the viewer.
    expect(src()).not.toContain('rootMargin');
    expect(src()).toMatch(/threshold:/);
  });

  it('the iframe carries its own dimensions — the player lays out from them', () => {
    expect(src()).toMatch(/width="100%"/);
    expect(src()).toMatch(/height="100%"/);
  });
});
