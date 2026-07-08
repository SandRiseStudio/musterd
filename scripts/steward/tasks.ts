/*
 * Steward seat (ADR 112) — the task registry: config-as-code, one entry per finder, each with its own
 * autonomy level. This is the reusable primitive the ADR calls for — raising or lowering a task's trust
 * (or giving a future specialized seat a bespoke level) is an edit here, reviewed like any other change.
 *
 *   - `propose`    → the finding becomes a draft change a human approves (v1: a tracked issue; with the
 *                    agent layer, a draft PR). Keeps "curated is a feature" (ADR 048) intact.
 *   - `auto-merge` → the seat may land a purely mechanical, statically-guarded fix unattended (still a PR
 *                    through the same protected-main gates; the static check is the seatbelt).
 *
 * v1 note: every finder ships as `propose`. The mechanical drift a deterministic `auto-merge` task would
 * fix is *already prevented from reaching main* by the static checks (roadmap-truth:check et al.) — so
 * there is honestly no deterministic auto-merge work yet. The level exists and the workflow honours it;
 * the first `auto-merge` task lands with the judgment/agent layer (or a genuine check-gap), by config.
 */

export type Autonomy = 'propose' | 'auto-merge';

export type FinderId = 'reverse_drift' | 'unmarked_feature' | 'stale_prose';

export interface StewardTask {
  /** Stable task id (the branch/label/issue-section name). */
  id: string;
  /** The scan finder that feeds this task. */
  finder: FinderId;
  autonomy: Autonomy;
  /** One line: what drift this task owns. */
  charter: string;
}

export const TASKS: StewardTask[] = [
  {
    id: 'roadmap-reconcile',
    finder: 'reverse_drift',
    autonomy: 'propose',
    charter:
      'A shipped-but-unmarked item (its freezing ADR is accepted) — mark it shipped with its PR.',
  },
  {
    id: 'undeclared-work',
    finder: 'unmarked_feature',
    autonomy: 'propose',
    charter:
      'A merged feature that no roadmap item anchors — add an item, or anchor an existing one.',
  },
  {
    id: 'stale-prose',
    finder: 'stale_prose',
    autonomy: 'propose',
    charter: 'A doc that says "not yet built" while its cited ADR is accepted — refresh the prose.',
  },
];

export const taskFor = (finder: FinderId): StewardTask => TASKS.find((t) => t.finder === finder)!;
