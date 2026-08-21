import { describe, expect, it } from 'vitest';
import { CONTROLS, type Control } from '../docs/controls/registry.ts';
import { checkControls } from './check-controls.ts';

/*
 * Tests for the control-liveness gate.
 *
 * The point of this file is narrow and specific: **prove every rule can actually fail.** A gate
 * whose failure path never executes is an unexercised control, and shipping one alongside a
 * registry built to catch unexercised controls would be self-refuting. So each rule gets a case
 * that trips it, not just a green run over the real registry.
 *
 * The real corpus is also asserted (last describe block), for the reason scripts/adr-status.test.ts
 * gives: a synthetic fixture passes the shape you imagined, and the defect lives in the gap between
 * that shape and what is actually on disk.
 */

/**
 * A minimal valid control; each test breaks exactly one field.
 *
 * The override map admits an explicit `undefined` (and then strips the key) because the repo runs
 * `exactOptionalPropertyTypes`: under it, `{ lastExercised: undefined }` is NOT the same as an
 * absent key, and testing rule 1 requires producing a genuinely absent one.
 */
type Overrides = { [K in keyof Control]?: Control[K] | undefined };

function control(over: Overrides = {}): Control {
  const merged: Overrides = {
    id: 'sample',
    kind: 'gate',
    claim: 'Something is prevented.',
    where: 'scripts/somewhere.ts',
    exercise: 'Break it deliberately and watch the gate fail.',
    motivatedBy: 'An incident on 2026-08-19 (#918).',
    counterfactual:
      'Yes — it fails on the exact pre-fix configuration, verified by the parity test.',
    lastExercised: '2026-08-20',
    everTripped: false,
    staleAfterDays: 90,
    refs: ['PR #918'],
    ...over,
  };
  for (const key of Object.keys(merged) as (keyof Control)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged as Control;
}

const NOW = new Date('2026-08-20T12:00:00Z');
const check = (c: Control) => checkControls([c], NOW);

describe('rule 1 — exercised XOR never-exercised (absence must be stated)', () => {
  it('accepts a control with a date', () => {
    expect(check(control())).toEqual([]);
  });

  it('accepts a control that states why it has never been exercised', () => {
    expect(
      check(
        control({
          lastExercised: undefined,
          neverExercised: 'Shipped 2026-08-04 and no seat has fired it on purpose since.',
        }),
      ),
    ).toEqual([]);
  });

  // The hole ADR 177 closed for the roadmap, closed here on arrival rather than after it bites.
  it('REJECTS a control that declares neither — silence must not read as "never"', () => {
    const errs = check(control({ lastExercised: undefined }));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/exactly one of `lastExercised`/);
  });

  it('REJECTS a control that declares both', () => {
    const errs = check(
      control({ neverExercised: 'Never got round to exercising this one at all.' }),
    );
    expect(errs[0]).toMatch(/exactly one of `lastExercised`/);
  });

  it('REJECTS a placeholder reason', () => {
    const errs = check(control({ lastExercised: undefined, neverExercised: 'TODO' }));
    expect(errs[0]).toMatch(/must state a real reason/);
  });
});

describe('rule 2 — dates are real and not in the future', () => {
  it('REJECTS a malformed date', () => {
    expect(check(control({ lastExercised: '19th Aug' }))[0]).toMatch(/must be a real ISO date/);
  });

  // `new Date('2026-02-31')` silently rolls over to March 3rd, so a regex alone is not enough.
  it('REJECTS a date that passes the regex but is not a calendar date', () => {
    expect(check(control({ lastExercised: '2026-02-31' }))[0]).toMatch(/must be a real ISO date/);
  });

  it('REJECTS a future date — it would put the control permanently out of staleness', () => {
    expect(check(control({ lastExercised: '2027-01-01' }))[0]).toMatch(/is in the future/);
  });

  it('accepts today', () => {
    expect(check(control({ lastExercised: '2026-08-20' }))).toEqual([]);
  });
});

describe('rule 3 — a claimed catch carries a date', () => {
  it('REJECTS everTripped without lastTripped', () => {
    const errs = check(control({ everTripped: true }));
    expect(errs[0]).toMatch(/no `lastTripped` date/);
  });

  it('REJECTS lastTripped without everTripped — the two must agree', () => {
    expect(check(control({ lastTripped: '2026-08-19' }))[0]).toMatch(/they disagree/);
  });

  it('accepts a dated catch', () => {
    expect(check(control({ everTripped: true, lastTripped: '2026-08-19' }))).toEqual([]);
  });
});

describe('rule 4 — the counterfactual is answered', () => {
  it('REJECTS a stub', () => {
    expect(check(control({ counterfactual: 'yes' }))[0]).toMatch(/must answer `counterfactual`/);
  });

  // "No" is the answer that made ryder throw away a dating check on 2026-08-19 rather than ship it
  // as reassurance. It must be expressible, or the field only ever collects self-congratulation.
  it('ACCEPTS an honest "no" — a control that admits it would have missed still registers', () => {
    expect(
      check(
        control({
          counterfactual:
            'No — it would have passed on the very case that prompted it, because the failing input never reaches this path.',
        }),
      ),
    ).toEqual([]);
  });
});

describe('rule 5 — staleness can actually fail', () => {
  it('REJECTS evidence older than the control’s own bound', () => {
    const errs = check(control({ lastExercised: '2026-01-01', staleAfterDays: 90 }));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/past its own 90d staleness bound/);
  });

  it('accepts evidence exactly at the bound', () => {
    // 2026-05-22 → 2026-08-20 is 90 days.
    expect(check(control({ lastExercised: '2026-05-22', staleAfterDays: 90 }))).toEqual([]);
  });

  it('does NOT stale-check a never-exercised control — there is no date to age', () => {
    expect(
      check(
        control({
          lastExercised: undefined,
          neverExercised: 'Warn-only gate; nobody has fired it deliberately since it shipped.',
          staleAfterDays: 1,
        }),
      ),
    ).toEqual([]);
  });

  it('REJECTS a non-positive staleness bound', () => {
    expect(check(control({ staleAfterDays: 0 }))[0]).toMatch(/must be positive/);
  });
});

describe('registry-wide invariants', () => {
  it('REJECTS duplicate ids', () => {
    const errs = checkControls([control(), control()], NOW);
    expect(errs.some((e) => /duplicate id/.test(e))).toBe(true);
  });

  // The real corpus, for the scripts/adr-status.test.ts reason: the shape you imagine always
  // passes; the gap between it and what is on disk is where the defect lives.
  it('the shipped registry passes its own gate', () => {
    expect(checkControls(CONTROLS, new Date())).toEqual([]);
  });

  it('the shipped registry is non-empty and every control names a reference', () => {
    expect(CONTROLS.length).toBeGreaterThan(0);
    for (const c of CONTROLS) expect(c.refs.length).toBeGreaterThan(0);
  });
});
