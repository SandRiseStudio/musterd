import { describe, expect, it } from 'vitest';
import { classifyCssBundle } from './css-bundles.ts';

const bundles = {
  app: ['Live', 'Board'],
  site: ['routes'],
  shared: ['brand'],
} as const;

describe('classifyCssBundle', () => {
  it('matches the declared pre-hash basename when a Vite hash contains a hyphen', () => {
    expect(classifyCssBundle('assets/Live-Cs78-rix.css', bundles)).toEqual({
      base: 'Live',
      group: 'app',
    });
  });

  it('leaves an undeclared stylesheet unclassified', () => {
    expect(classifyCssBundle('assets/Mystery-abc123.css', bundles)).toEqual({
      base: 'Mystery-abc123',
      group: undefined,
    });
    expect(classifyCssBundle('assets/Live-Settings-hash.css', bundles)).toEqual({
      base: 'Live-Settings-hash',
      group: undefined,
    });
  });
});
