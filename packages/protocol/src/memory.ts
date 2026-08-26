import { z } from 'zod';

/**
 * Team memory retrieval shapes (ADR 327) — the read side of the `insight` act. The index behind
 * `GET /teams/:slug/memory/search` is a derived, rebuildable FTS fold over the message log (never a
 * source of truth, ADR 259); these schemas describe only what the wire returns.
 */

export const InsightHitSchema = z.object({
  /** The insight act's envelope id — join key back to the durable log. */
  id: z.string().min(1),
  /** Seat name of the finder (resolved from `from_member` at read time). */
  from: z.string().min(1),
  headline: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  ts: z.number().int().nonnegative(),
});
export type InsightHit = z.infer<typeof InsightHitSchema>;

export const TeamMemorySearchResponseSchema = z.object({
  results: z.array(InsightHitSchema),
});
export type TeamMemorySearchResponse = z.infer<typeof TeamMemorySearchResponseSchema>;
