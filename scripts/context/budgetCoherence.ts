/*
 * Is a standing-context budget set internally satisfiable? (`pnpm context:check`)
 *
 * A composite budget below the sum of its parts' budgets describes a state that passes every line
 * item and fails the headline. "Trim it" is then advice that cannot work, and the contributor who
 * trips the gate has done nothing wrong — they simply added the byte that revealed a contradiction
 * already sitting in the file.
 *
 * This is a property of the BUDGETS, never of the measurements: it is wrong the moment it is
 * written, not later when something finally grows into it. Split out of `check-budgets.ts` because
 * that module runs the whole gate (and calls `process.exit`) on import, so the rule could not
 * otherwise be tested.
 */

/** What each headline is made of. Keys are budget item names. */
export type Composition = Record<string, readonly string[]>;

/** Just the field this rule reads; the real budget file carries `justification` alongside. */
export interface BudgetLike {
  budget: number;
}

/**
 * One message per composite whose budget cannot be met even with every component exactly at its
 * own. Empty when the set is satisfiable. A composite with no budget line is not this rule's
 * business — `check-budgets.ts` already reports unbudgeted and unmeasured items.
 */
export function coherenceFailures(
  items: Record<string, BudgetLike>,
  composites: Composition,
): string[] {
  const failures: string[] = [];
  const budgetOf = (item: string): number => items[item]?.budget ?? 0;
  for (const [composite, parts] of Object.entries(composites)) {
    if (!items[composite]) continue;
    const partsSum = parts.reduce((n, part) => n + budgetOf(part), 0);
    const budget = budgetOf(composite);
    if (budget < partsSum) {
      failures.push(
        `${composite}: budget ${budget} B is below the sum of its parts' budgets ` +
          `(${partsSum} B, short by ${partsSum - budget}). Every component could sit exactly at ` +
          `its own justified budget and this headline would still fail, so trimming cannot ` +
          `satisfy the gate. Raise this budget to at least ${partsSum} (with a new ` +
          `justification), or lower the component budgets it is meant to bound: ` +
          `${parts.join(', ')}.`,
      );
    }
  }
  return failures;
}
