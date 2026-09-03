import { PROBE_CAPABLE_SURFACES } from '@musterd/mcp';
import { describe, expect, it } from 'vitest';
import { HARNESSES } from './index.js';

/**
 * The pin that keeps `PROBE_CAPABLE_SURFACES` honest.
 *
 * The adapter must know which surfaces can be probed in order to warn about a declared attestation
 * (`packages/mcp/src/modelProbe.ts`), but the registry that owns that truth is here in the CLI, and
 * `@musterd/cli` depends on `@musterd/mcp` — not the reverse. So the list is hand-kept over there
 * and checked from here, on the side of the dependency edge that can see both.
 *
 * Add an `observeModel` slot to a harness without adding its surface to the list and this fails,
 * which is the whole point: a probe nobody knows about is a seat that silently keeps attesting a
 * snapshot — the defect the warning exists to catch, reappearing one level up.
 */
describe('PROBE_CAPABLE_SURFACES is exactly the registry (ADR 101/158 follow-up)', () => {
  it('matches the harnesses that actually declare an observeModel probe', () => {
    const fromRegistry = HARNESSES.filter((h) => h.observeModel)
      .map((h) => h.surface)
      .sort();

    expect(fromRegistry).toEqual([...PROBE_CAPABLE_SURFACES].sort());
  });

  it('every registry harness is accounted for — a probeless one must be absent, not forgotten', () => {
    for (const h of HARNESSES) {
      expect(PROBE_CAPABLE_SURFACES.includes(h.surface as never)).toBe(Boolean(h.observeModel));
    }
  });
});
