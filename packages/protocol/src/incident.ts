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

/**
 * Per-team incident policy (spec §5, increment 2) — the knobs that were constants in increment 1.
 *
 * The posture deliberately DIFFERS from `loops`, in both directions:
 *
 * - **Clustering defaults ON.** Increment 1 shipped it on for every team with no switch, so a
 *   default-off block would silently remove shipped behaviour at upgrade. `enabled: false` is an
 *   opt-OUT that degrades to pre-increment-1 exactly.
 * - **Both wake knobs default OFF**, though the spec asked for `true`. Wakes spend, and every other
 *   spending switch in this repo is opt-in (`loops` is the precedent). The spec's `true` was written
 *   assuming wake pricing was sound; it is measurably not — `residency.wake_cost` is only ever
 *   written on the report path, so a lease that spawns a session and never reports is reaped as a
 *   bare `wake_failed` with no number attached. Leases can multiply against zero priced wakes and
 *   nothing in the ledger is lying. Turning a NEW wake edge on for every team at upgrade, on top of
 *   accounting that cannot see what it costs, is not a default anyone can defend. An admin who wants
 *   it writes one policy knob.
 */
export const IncidentPolicySchema = z.object({
  /** false degrades to pre-increment-1 exactly: reports stay ordinary meta, nothing clusters. */
  enabled: z.boolean().default(true),
  /** Distinct reporting seats that auto-open an incident. Two is the shipped increment-1 constant. */
  cluster_threshold: z.number().int().min(2).default(2),
  /** How long any seat may claim before the fallback role is assigned. 0 = assign at once. */
  claim_window_ms: z.number().int().min(0).default(600_000),
  /** Default owner when nobody claims. Roles route, they do not monopolize — any seat may claim first. */
  fallback_role: z.string().min(1).default('platform'),
  /** Wake the fallback owner at claim-window close, if they are asleep and wakeable. */
  wake_on_route: z.boolean().default(false),
  /** Wake reporters whose refs were parked, when the incident resolves. */
  wake_on_resolve: z.boolean().default(false),
});
export type IncidentPolicy = z.infer<typeof IncidentPolicySchema>;

/** Typed accessor over loose envelope meta (same posture as `eligibleOf`). */
export function blockedByOf(meta: Record<string, unknown> | null | undefined): BlockedBy | null {
  if (!meta || meta['blocked_by'] === undefined) return null;
  const parsed = BlockedBySchema.safeParse(meta['blocked_by']);
  return parsed.success ? parsed.data : null;
}
