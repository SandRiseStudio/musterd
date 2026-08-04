import { z } from 'zod';

/**
 * Per-team loop enable switches (ADR 179 / ADR 191 / ADR 199). Each loop is independently
 * installable — the trust ramp is loop-by-loop, never all at once. `parse({})` yields every loop
 * off: bit-identical to pre-179 until an admin opts in.
 */
export const LoopsPolicySchema = z.object({
  /** Review loop: wake a marked-wakeable offline reviewer when `lane_ready` finds nobody live. */
  review: z.boolean().default(false),
  /** Dispatch loop: work-order wake the lane owner (handoff + continuation edges, ADR 199). */
  dispatch: z.boolean().default(false),
  /**
   * Backstop sweep (ADR 229): close a lane that has waited past the grace period in
   * `awaiting_acceptance`, because nothing else ever will — the ADR 217 close reasons label a close,
   * they never cause one. Records `review_swept`, never verified. The grace is deliberately far
   * above the observed mean time-in-review so the sweep collects what acceptance has finished with
   * rather than competing with it.
   */
  sweep: z.boolean().default(false),
});
export type LoopsPolicy = z.infer<typeof LoopsPolicySchema>;
