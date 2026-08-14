/**
 * Incident convergence increment 2 — the norm, taught where it is needed.
 *
 * A shared CI gate is the one place that KNOWS a red just happened and knows which check it was.
 * Increment 1 put the reporting norm in the on-demand `musterd` skill body instead, on the theory
 * that a seat would go read it; the measured result over the days after it shipped was zero reports
 * filed, from any seat, ever. The primer was considered and refused — the per-session context
 * budgets had ~47 B of slack and taxing every session for a rare event is the wrong trade.
 *
 * So the gate teaches. It costs no context budget, it reaches exactly the seats who hit the red, and
 * it arrives at the moment the seat is deciding whether to start debugging.
 *
 * It also supplies the CANONICAL GATE STRING, which is load-bearing. Clustering is exact-match on
 * `gate` (spec §1: element-level signatures split one defect into many incidents), so two seats must
 * state the check name identically without talking to each other. Printing it removes that
 * coordination problem rather than betting on two agents phrasing a check name the same way.
 *
 * Gate strings are `ci:<job>/<step>` as GitHub Actions names them, so a seat reading a red check in
 * the PR UI and a seat reading this notice arrive at the same key.
 */

/** The canonical keys. A gate that starts sharing reds adds itself here and prints the notice. */
export const SHARED_BLOCKER_GATES = {
  a11yContrast: 'ci:gates/A11y contrast',
};

/**
 * The notice block for one gate, or '' when there is nothing to say (so a caller can concatenate it
 * unconditionally). Deliberately plain text: this is read in CI logs and in a terminal.
 */
export function sharedBlockerNotice(gate) {
  if (!gate) return '';
  return [
    '',
    '  ── if this red is not yours ────────────────────────────────────────',
    "  A red on a check your diff can't touch is not yours to debug. Report",
    '  it, park the work, and move on:',
    '',
    `      musterd send --blocked-by "${gate}"`,
    '',
    '  When a second seat reports the same gate, musterd opens ONE owned',
    '  incident lane and points everyone else at it. The measured alternative',
    '  was four seats independently diagnosing one defect for four hours.',
    '',
  ].join('\n');
}
