import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STAGE, stageSize } from './broadcast';

describe('stageSize', () => {
  it('reads the 720p rung off the query', () => {
    expect(stageSize('?h=720')).toEqual({ w: 1280, h: 720 });
    expect(stageSize('?team=revive&h=720&fps=25')).toEqual({ w: 1280, h: 720 });
  });

  it('falls back to 1080p for a missing, unknown or off-contract height', () => {
    // Two rungs only — this is a capture contract, not a slider.
    for (const search of ['', '?team=revive', '?h=', '?h=900', '?h=abc', '?h=1440']) {
      expect(stageSize(search), search).toEqual(DEFAULT_STAGE);
    }
    expect(stageSize('?h=1080')).toEqual({ w: 1920, h: 1080 });
  });
});

/**
 * The hydration guard.
 *
 * `/broadcast` is server-rendered, and the server has no `window` — so a stage size derived from the
 * URL during the *first* render disagrees with what the server wrote. React does not patch mismatched
 * attributes when it hydrates: it adopts the server's DOM and carries on. The state was right and the
 * pixels were wrong, forever, because nothing re-renders that element afterwards — `stage` never
 * changes and `scale` rarely does. The office then sized its canvas off a 1920×1080 host inside a
 * 1280×720 window and painted a room too big for the frame, which is what "the broadcast framing is
 * off" actually was.
 *
 * So the first render must be the SSR-safe default, and the URL must be applied in an effect — an
 * ordinary re-render, which React does patch. This is asserted against the source because the repo has
 * no DOM/hydration test rig (no jsdom, no testing-library); adding one is a real option and would let
 * this be tested properly, but it is a dependency decision rather than part of this fix.
 */
describe('the stage survives hydration', () => {
  const src = readFileSync(fileURLToPath(new URL('./broadcast.tsx', import.meta.url)), 'utf8');

  it('seeds the stage from the SSR-safe default, not from the URL', () => {
    expect(src).toMatch(/useState(<[^>]*>)?\(DEFAULT_STAGE\)/);
    expect(src, 'the URL must not decide the first render').not.toMatch(/useState\(\s*stageSize\b/);
  });

  it('applies the URL height in an effect, so React patches the DOM', () => {
    const effects = src.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/g) ?? [];
    expect(effects.some((e) => e.includes('stageSize(')), 'stageSize belongs in a mount effect').toBe(true);
  });
});
