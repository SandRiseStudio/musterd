import { describe, expect, it } from 'vitest';
import { SURFACES, SurfaceSchema } from './acts.js';
import { FEATURE_EPOCH } from './feature-epoch.js';

describe('SURFACES (ADR 352)', () => {
  it('admits grok as a first-class Surface', () => {
    expect(SurfaceSchema.safeParse('grok').success).toBe(true);
    expect(SURFACES).toContain('grok');
  });

  it('keeps grok beside the other CLI harnesses', () => {
    const i = SURFACES.indexOf('grok');
    expect(SURFACES[i - 1]).toBe('opencode');
    expect(SURFACES[i + 1]).toBe('cursor');
  });

  it('still refuses an unknown surface — widening is not opening', () => {
    expect(SurfaceSchema.safeParse('grok-cli').success).toBe(false);
    expect(SurfaceSchema.safeParse('definitely-not-a-surface').success).toBe(false);
  });
});

describe('FEATURE_EPOCH (Codex doorbell model seam, ADR 397)', () => {
  it('is 20 — an old checkout cannot rewrite the supported Codex hook command set', () => {
    expect(FEATURE_EPOCH).toBe(20);
  });
});
