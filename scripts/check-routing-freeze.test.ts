/**
 * A freeze gate that cannot be released is a trap, and one that never fires is decoration. Both
 * halves are asserted here, plus the self-expiry — the property that stops this outliving its
 * measurement and becoming friction nobody can explain.
 */
import { describe, expect, it } from 'vitest';
import { FREEZE_UNTIL, freezeVerdict } from './check-routing-freeze.ts';
import { ROUTING_PATHS } from './research/adr-260-acceptance-eval.ts';

const during = FREEZE_UNTIL - 86_400_000;
const after = FREEZE_UNTIL + 1;

describe('freezeVerdict', () => {
  it('passes a change that touches nothing frozen', () => {
    const v = freezeVerdict(['docs/wiki/acceptance-routing.md'], ['tidy the page'], during);
    expect(v.violations).toEqual([]);
    expect(v.frozen).toBe(true);
  });

  it('fires on each frozen path', () => {
    for (const p of ROUTING_PATHS) {
      expect(freezeVerdict([p], ['a change'], during).violations).toEqual([p]);
    }
  });

  it('reports every violation, not just the first', () => {
    const v = freezeVerdict([...ROUTING_PATHS], ['a change'], during);
    expect(v.violations).toHaveLength(ROUTING_PATHS.length);
  });

  it('releases on [unfreeze: reason] and keeps the reason for the record', () => {
    const v = freezeVerdict(
      ['packages/server/src/store/review.ts'],
      ['fix the picker\n\n[unfreeze: incident convergence needs the banner]'],
      during,
    );
    expect(v.override).toBe('incident convergence needs the banner');
  });

  it('finds the marker in any commit on the branch, not only the tip', () => {
    const v = freezeVerdict(
      ['packages/protocol/src/envelope.ts'],
      ['first commit', 'second\n[unfreeze: needed]', 'third'],
      during,
    );
    expect(v.override).toBe('needed');
  });

  it('is case-insensitive, because nobody remembers the casing of a gate they hit once', () => {
    expect(freezeVerdict(ROUTING_PATHS.slice(0, 1), ['[UNFREEZE: yes]'], during).override).toBe(
      'yes',
    );
  });

  it('treats a marker with an empty reason as no override — "why" is the whole point', () => {
    const v = freezeVerdict(ROUTING_PATHS.slice(0, 1), ['[unfreeze:]'], during);
    expect(v.override).toBeNull();
    expect(v.violations).toHaveLength(1);
  });

  it('goes inert after the window closes, even on a frozen path', () => {
    const v = freezeVerdict([...ROUTING_PATHS], ['no marker at all'], after);
    expect(v).toEqual({ frozen: false, violations: [], override: null });
  });

  it('does not freeze neighbours that merely live nearby', () => {
    const v = freezeVerdict(
      [
        'packages/server/src/store/review.test.ts',
        'packages/server/src/store/incidents.ts',
        'packages/protocol/src/lanes.ts',
      ],
      ['incident convergence inc 2'],
      during,
    );
    expect(v.violations).toEqual([]);
  });
});
