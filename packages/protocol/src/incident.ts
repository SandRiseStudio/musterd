import { z } from 'zod';
import { shortDuration } from './duration.js';

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

/** One entry of `NextBrief.incidents`, as both renderers receive it. */
export interface IncidentBannerItem {
  lane: string;
  gate: string;
  owner_seat: string | null;
  opened_at: number;
  claim_closes_at?: number | null | undefined;
  fallback_role?: string | null | undefined;
}

/**
 * The incident banner, as words — shared by every surface that shows one (ADR 084).
 *
 * This lives in the protocol package because the alternative was already measured and it failed
 * quietly: increments 1 and 2 put the banner only in the MCP renderer, so every CLI seat running
 * `musterd next` got NO banner at all — on the surface that most needs orientation, for the feature
 * ADR 266 calls "the cheapest, highest-leverage piece" precisely because the measured waste was
 * seats STARTING SESSIONS into a shared red they assumed was theirs.
 *
 * Note the shape of that failure, because ADR 084 is usually read as being about derivation: the
 * derivation WAS correctly shared (`deriveNext`, server-side). What drifted was the RENDERER — a
 * second copy that silently lacked a section. So the words move here too, and the next surface gets
 * them by importing rather than by remembering.
 *
 * Returns plain lines, no colour: callers own their own theming.
 */
export function incidentBannerLines(inc: IncidentBannerItem, now: number = Date.now()): string[] {
  const who = inc.owner_seat ? `owned by ${inc.owner_seat}` : 'UNCLAIMED';
  // Absent (pre-271 daemon) and null (owned, or convergence disabled) both mean "no countdown to
  // state" — and must read as nothing at all, never as missing data.
  const left = inc.claim_closes_at == null ? null : inc.claim_closes_at - now;
  const role = inc.fallback_role ?? null;
  const window =
    left == null
      ? ''
      : left > 0
        ? role
          ? ` — yours to claim for ${shortDuration(left)}, then it falls to ${role}`
          : ` — yours to claim for ${shortDuration(left)}; NOBODY holds the fallback role, so after that it just sits`
        : role
          ? ` — claim window closed, routing to ${role}`
          : ` — claim window closed and NOBODY holds the fallback role: this will sit unowned until someone takes it`;
  return [
    `⚠ incident: ${inc.gate} — ${who} (lane ${inc.lane}, open ${shortDuration(now - inc.opened_at)})${window}.`,
    `  If your red matches, it is not yours. Report blocked_by and park behind it.`,
  ];
}

/** Typed accessor over loose envelope meta (same posture as `eligibleOf`). */
export function blockedByOf(meta: Record<string, unknown> | null | undefined): BlockedBy | null {
  if (!meta || meta['blocked_by'] === undefined) return null;
  const parsed = BlockedBySchema.safeParse(meta['blocked_by']);
  return parsed.success ? parsed.data : null;
}
