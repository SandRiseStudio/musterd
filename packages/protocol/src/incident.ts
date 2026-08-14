import { z } from 'zod';

/**
 * Incident convergence (spec 2026-08-14, increment 1). A seat that hits a red it cannot explain
 * attaches this to the `status_update` it already sends — no new act. `gate` is the cluster key,
 * exact match only: element-level signatures would split one defect into many incidents, and
 * check-name granularity is what seats can state identically without coordinating. `sig` rides
 * along for the eventual owner and is never matched on. `ref` is what is parked behind the red.
 */
export const BlockedBySchema = z.object({
  gate: z.string().min(1),
  ref: z.string().min(1).optional(),
  sig: z.string().min(1).optional(),
});
export type BlockedBy = z.infer<typeof BlockedBySchema>;

/** Typed accessor over loose envelope meta (same posture as `eligibleOf`). */
export function blockedByOf(meta: Record<string, unknown> | null | undefined): BlockedBy | null {
  if (!meta || meta['blocked_by'] === undefined) return null;
  const parsed = BlockedBySchema.safeParse(meta['blocked_by']);
  return parsed.success ? parsed.data : null;
}
