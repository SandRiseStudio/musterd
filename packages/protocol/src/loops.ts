import { z } from 'zod';

/**
 * Per-team loop enable switches (ADR 179 / ADR 191). Each loop is independently installable —
 * the trust ramp is loop-by-loop, never all at once. `parse({})` yields every loop off: bit-identical
 * to pre-179 until an admin opts in.
 */
export const LoopsPolicySchema = z.object({
  /** Review loop: wake a marked-wakeable offline reviewer when `lane_ready` finds nobody live. */
  review: z.boolean().default(false),
});
export type LoopsPolicy = z.infer<typeof LoopsPolicySchema>;
