import { GENERALIST_CAPABILITIES } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { measureToolSurface } from './surfaceMeasure.js';

/**
 * The standing-context budget's tools/list instrument (spec 2026-08-03): the same in-memory
 * listing `scopeSurface.test.ts` pins for scope-by-role, returned in the `SurfaceRender` shape so
 * the script and the inc-1 telemetry attestation agree on the formula.
 */
describe('measureToolSurface', () => {
  it('returns the full-surface weight with a per-tool breakdown', async () => {
    const s = await measureToolSurface(GENERALIST_CAPABILITIES);
    expect(s.tools).toBeGreaterThan(15);
    expect(s.bytes).toBeGreaterThan(5_000);
    expect(s.est_tokens).toBe(Math.round(s.bytes / 4));
    expect(s.breakdown?.length).toBe(s.tools);
    for (const t of s.breakdown ?? []) expect(t.bytes).toBeGreaterThanOrEqual(t.description_bytes);
  });

  it('a muted seat weighs less than a generalist', async () => {
    const [full, muted] = await Promise.all([
      measureToolSurface(GENERALIST_CAPABILITIES),
      measureToolSurface({ ...GENERALIST_CAPABILITIES, can_message: 'none' }),
    ]);
    expect(muted.bytes).toBeLessThan(full.bytes);
  });
});
