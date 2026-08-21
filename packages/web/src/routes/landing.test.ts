import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = () => readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8');

describe('landing page', () => {
  it('uses the typographic hero, not the canvas office scene', () => {
    expect(src()).toContain('LightHero');
    expect(src()).not.toMatch(/components\/Hero\/Hero|office-scene/);
  });
  it('no longer pulls the /live stylesheet', () => {
    expect(src()).not.toContain('Live.css');
  });
});
