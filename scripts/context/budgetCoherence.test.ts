import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type BudgetLike, type Composition, coherenceFailures } from './budgetCoherence.ts';

/*
 * The gate must be satisfiable by obeying its own per-item guidance.
 *
 * This rule exists because it was violated, live, for a day: `perTurnTotalBytes` sat 795 B below
 * the sum of its parts' budgets, so a fully item-compliant standing context failed the headline and
 * `context:check` told whoever tripped it to "trim it, or raise the budget" — advice that could not
 * work. It was reachable: the per-turn headroom was down to 7 B, and the next word added to any MCP
 * tool description would have failed a gate that was already unsatisfiable, looking like their bug.
 *
 * So the tests prove the rule can FAIL (a green run over a correct file proves nothing about a rule
 * that never executes), and the last block asserts the real file — the fixture/disk gap that
 * scripts/adr-status.test.ts and scripts/controls.test.ts both make a point of closing.
 */

const items = (o: Record<string, number>): Record<string, BudgetLike> =>
  Object.fromEntries(Object.entries(o).map(([k, budget]) => [k, { budget }]));

const COMPOSITION: Composition = { total: ['a', 'b'] };

describe('coherenceFailures — a composite may not promise less than its parts', () => {
  it('fails a composite below the sum of its parts, naming the shortfall and both repairs', () => {
    const [failure, ...rest] = coherenceFailures(items({ a: 100, b: 50, total: 120 }), COMPOSITION);

    expect(rest).toEqual([]);
    expect(failure).toContain('short by 30');
    // Both knobs, because which one is right is a judgement the gate must not make for you.
    expect(failure).toContain('Raise this budget to at least 150');
    expect(failure).toContain('a, b');
  });

  it('passes when the composite exactly equals its parts — the minimal coherent set', () => {
    expect(coherenceFailures(items({ a: 100, b: 50, total: 150 }), COMPOSITION)).toEqual([]);
  });

  it('passes when the composite exceeds its parts — slack is legal, deficit is not', () => {
    expect(coherenceFailures(items({ a: 100, b: 50, total: 999 }), COMPOSITION)).toEqual([]);
  });

  it('reports each incoherent composite separately', () => {
    const failures = coherenceFailures(items({ a: 100, b: 50, x: 10, total: 1, other: 1 }), {
      total: ['a', 'b'],
      other: ['a', 'x'],
    });

    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('total:');
    expect(failures[1]).toContain('other:');
  });

  /*
   * A missing part reads as 0 rather than throwing, and that is deliberate: a composition naming an
   * item with no budget line is already reported by check-budgets.ts's own unbudgeted/unmeasured
   * loops. Failing here too would bury the real message under a second one about the same typo.
   */
  it('treats an unbudgeted part as 0 rather than throwing', () => {
    expect(coherenceFailures(items({ a: 100, total: 100 }), COMPOSITION)).toEqual([]);
  });

  it('says nothing about a composite that has no budget line of its own', () => {
    expect(coherenceFailures(items({ a: 100, b: 50 }), COMPOSITION)).toEqual([]);
  });
});

describe('the real budget file', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const budgets = JSON.parse(
    readFileSync(join(here, '..', '..', 'docs', 'perf', 'context-budgets.json'), 'utf8'),
  ) as { items: Record<string, BudgetLike> };

  // Kept in step with check-budgets.ts by the assertion below, not by hope.
  const REAL: Composition = {
    perTurnTotalBytes: ['toolsListDefaultBytes', 'promptSubmitNudgeBytes', 'labelNudgeBytes'],
    perSessionTotalBytes: [
      'toolsListDefaultBytes',
      'primerBytes',
      'sessionStartNudgesBytes',
      'promptSubmitNudgeBytes',
      'labelNudgeBytes',
    ],
  };

  it('is coherent as committed', () => {
    expect(coherenceFailures(budgets.items, REAL)).toEqual([]);
  });

  it('declares every item this composition names', () => {
    for (const [composite, parts] of Object.entries(REAL))
      for (const item of [composite, ...parts]) expect(budgets.items[item]).toBeDefined();
  });

  /*
   * The regression itself, reconstructed from the file as committed on 2026-08-20 before the fix:
   * components re-baselined at measurement+5% (toolsListDefault 16646) while the composite kept an
   * older, smaller baseline (16051). That is the shape this rule exists to refuse, and it is the
   * shape it takes whenever a part is re-justified without re-checking the whole it belongs to.
   */
  it('would have caught the 2026-08-20 contradiction', () => {
    const before = {
      ...budgets.items,
      toolsListDefaultBytes: { budget: 16646 },
      perTurnTotalBytes: { budget: 16051 },
    };

    const [failure] = coherenceFailures(before, REAL);
    expect(failure).toContain('perTurnTotalBytes');
    expect(failure).toContain('short by 795');
  });

  /*
   * The other direction, which is the one that matters for keeping standing context small: parts
   * that exactly spend the ceiling are coherent, and the NEXT byte fails a component rather than
   * silently inflating the total. Raising the ceiling stays possible — it just has to be done on
   * purpose, in one place, with an argument.
   */
  it('leaves the ceiling binding: the parts exactly spend perTurnTotalBytes', () => {
    const parts = REAL['perTurnTotalBytes']!.reduce(
      (n, part) => n + budgets.items[part]!.budget,
      0,
    );

    expect(parts).toBe(budgets.items['perTurnTotalBytes']!.budget);
  });
});
