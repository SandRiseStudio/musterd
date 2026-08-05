import { describe, expect, it } from 'vitest';
import { resolveStakesDefault, type StakesDefault } from './lanes.js';

/**
 * ADR 244 — the matcher an admin's default-stakes rule runs through. This is the whole surface where
 * "the path rule, but declared by a human" could quietly become "the path rule ADR 234 rejected", so
 * the properties that keep it narrow are pinned here rather than left to the caller.
 */
describe('resolveStakesDefault', () => {
  const web: StakesDefault = { surface: 'packages/web/**', stakes: 'low' };

  it('matches a lane whose declared surfaces all sit under the rule', () => {
    expect(resolveStakesDefault([web], ['packages/web/src/live/**'])).toEqual(web);
    expect(resolveStakesDefault([web], ['packages/web/src/a.ts', 'packages/web/src/b.ts'])).toEqual(
      web,
    );
  });

  it('does NOT match when any declared surface falls outside — all, never any', () => {
    // The safety property. If `any` matched, a worker could exempt a server change by naming one web
    // file beside it, and the exemption would be one glob away from anything at all. A lane touching
    // web AND server is not a web lane.
    expect(
      resolveStakesDefault([web], ['packages/web/src/live/**', 'packages/server/src/store/**']),
    ).toBeUndefined();
  });

  it('does NOT match a lane that declared no surface at all', () => {
    // A lane that did not say where it works has not earned a surface-based default. Fails safe to
    // `normal` rather than inheriting the broadest rule by silence.
    expect(resolveStakesDefault([web], [])).toBeUndefined();
  });

  it('normalizes the trailing glob, so the two ways an admin writes it mean the same thing', () => {
    for (const surface of ['packages/web/**', 'packages/web/*', 'packages/web/', 'packages/web']) {
      expect(resolveStakesDefault([{ surface, stakes: 'low' }], ['packages/web/src/x.ts'])).toEqual(
        {
          surface,
          stakes: 'low',
        },
      );
    }
  });

  it('first match wins, so an admin can put a specific rule ahead of a broad one', () => {
    const rules: StakesDefault[] = [
      { surface: 'packages/web/src/routes/**', stakes: 'normal' },
      { surface: 'packages/web/**', stakes: 'low' },
    ];
    // The narrow rule is listed first and takes it, even though the broad one also matches.
    expect(resolveStakesDefault(rules, ['packages/web/src/routes/live.tsx'])?.stakes).toBe(
      'normal',
    );
    // …and a lane the narrow rule misses still gets the broad one.
    expect(resolveStakesDefault(rules, ['packages/web/src/live/client.ts'])?.stakes).toBe('low');
  });

  it('is inert with no rules — the out-of-box posture', () => {
    expect(resolveStakesDefault([], ['packages/web/src/x.ts'])).toBeUndefined();
  });

  it('does not match a sibling directory that merely shares a prefix string', () => {
    // `packages/web` must not swallow `packages/webhooks` — in EVERY spelling, including the
    // shortest one an admin is most likely to type. Normalizing to a `/`-terminated prefix is what
    // makes the rule mean what it looks like it means; without it the bare form widens silently
    // across a sibling package and the admin never sees it.
    for (const surface of ['packages/web/**', 'packages/web/', 'packages/web']) {
      expect(
        resolveStakesDefault([{ surface, stakes: 'low' }], ['packages/webhooks/src/x.ts']),
      ).toBeUndefined();
    }
  });
});
