/**
 * The lane vocabulary as plain TypeScript — no zod. `lanes.ts` builds its enums from these tuples
 * and re-exports every name, so the board's states and stakes have one home and the browser can
 * read a lane board without pulling a validator into its bundle (`guards.ts`).
 */

export const LANE_STATES = [
  'open',
  'claimed',
  'active',
  'blocked',
  /** Canonical post-merge outcome-acceptance stage (ADR 192). */
  'awaiting_acceptance',
  /**
   * Legacy alias for `awaiting_acceptance` (ADR 169 name). Dual-accepted for fleet skew; new writes
   * use `awaiting_acceptance`. Prefer {@link isAwaitingAcceptance} over raw equality.
   */
  'ready_for_review',
  'done',
  'abandoned',
] as const;
export type LaneState = (typeof LANE_STATES)[number];

export const LANE_STAKES = ['low', 'normal', 'high'] as const;
export type LaneStakes = (typeof LANE_STAKES)[number];

export const LANE_STAKES_PROVENANCE = ['declared', 'defaulted'] as const;
export type LaneStakesProvenance = (typeof LANE_STAKES_PROVENANCE)[number];

/**
 * The two spellings of the post-merge acceptance stage (ADR 192). Read through this rather than
 * comparing against either name: `ready_for_review` is the ADR 169 spelling still on the wire.
 */
export function isAwaitingAcceptance(state: string): boolean {
  return state === 'awaiting_acceptance' || state === 'ready_for_review';
}

/** value-layer design: a lane in `awaiting_acceptance` longer than this warns `stale_acceptance`. */
export const ACCEPTANCE_STALE_MS = 12 * 60 * 60 * 1000;

/**
 * The verification tiers a submit can persist (merge-verified submit). `not_ancestor` is
 * deliberately not a member: it is a refusal outcome at `lane_submit`, never a stored state.
 */
export const MERGE_VERIFICATION_TIERS = [
  'ancestor',
  'unknown_object',
  'fetch_failed',
  'unattested',
] as const;
export type MergeVerification = (typeof MERGE_VERIFICATION_TIERS)[number];
