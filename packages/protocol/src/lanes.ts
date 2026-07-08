import { z } from 'zod';
import { GoalSchema } from './goals.js';

/**
 * Coordination lanes, Phase 1 (ADR 083) — the { work-item × owner × surface } unit that makes
 * work-ownership contention-aware. Declarations only in P1: `surface_globs` + `depends_on` are the
 * whole engine; the two checks (unmet dependency, surface overlap) are **warn-only, never blocking**,
 * and git is optional throughout (`branch` is just a carried artifact label).
 */

/** Lane lifecycle. `open` = unowned (claimable); `blocked`/`abandoned` are side states. */
export const LaneStateSchema = z.enum([
  'open',
  'claimed',
  'active',
  'blocked',
  'done',
  'abandoned',
]);
export type LaneState = z.infer<typeof LaneStateSchema>;

export const LaneSchema = z.object({
  id: z.string(),
  team: z.string(),
  /** Surface-space scope — contention is checked within a project, never across (ADR 068 workspace). */
  project: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  /** Owning seat name; null = open/unowned. */
  owner_seat: z.string().nullable(),
  /** Assignment hint (backend/frontend/…); advisory only in P1. */
  role: z.string().nullable(),
  /** Declared surface, e.g. ["packages/server/src/store/**"]. The overlap-check input. */
  surface_globs: z.array(z.string()),
  /** Lane ids this lane builds on. The unmet-dependency-check input. */
  depends_on: z.array(z.string()),
  /** The git branch/artifact carrying the work — what `lane_handoff` transfers. */
  branch: z.string().nullable(),
  /** Optional link up to a declared Goal (ADR 084). null = ungrouped; the join is flat, never a tree. */
  goal_id: z.string().nullable(),
  state: LaneStateSchema,
  created_by: z.string(),
  created_at: z.number().int(),
  claimed_at: z.number().int().nullable(),
  resolved_at: z.number().int().nullable(),
  updated_at: z.number().int(),
});
export type Lane = z.infer<typeof LaneSchema>;

/**
 * The lane contention + staleness signals. Advisory always — a warning never fails a verb.
 * Phase-1 (ADR 083): `unmet_dependency`, `surface_overlap`. Increment 3 (ADR 109 / ADR 088 §5) adds the
 * two staleness signals the interrupt line can't catch: `stale_plan` (the lane's own Goal moved epoch
 * since it was claimed) and `stale_dependency` (a lane it builds on had its Goal move). Both are
 * owner-directed, never broadcast — directory-based invalidation over the goal_id join + depends_on edge.
 */
export const LaneWarningSchema = z.object({
  kind: z.enum(['unmet_dependency', 'surface_overlap', 'stale_plan', 'stale_dependency']),
  /** The lane the acting party touched (staleness: the stale lane itself). */
  subject: z.string(),
  /** The other party: the depended-on/overlapping lane, or — for `stale_plan` — the moved Goal id. */
  with: z.string(),
  /** Who gets the directed wake (contention: the other lane's owner; staleness: the stale lane's owner); null if unowned. */
  owner: z.string().nullable(),
  detail: z.string(),
});
export type LaneWarning = z.infer<typeof LaneWarningSchema>;

/** Body for `POST /teams/:slug/lanes` (lane_open). `claim` self-owns at create (opt-in, ADR 083). */
export const OpenLaneSchema = z.object({
  title: z.string().min(1),
  detail: z.string().optional(),
  project: z.string().optional(),
  role: z.string().optional(),
  surface_globs: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  branch: z.string().optional(),
  /** Link this lane to a Goal at open (ADR 084) — the id `musterd next` groups + derives status by. */
  goal_id: z.string().optional(),
  claim: z.boolean().optional(),
});
export type OpenLane = z.infer<typeof OpenLaneSchema>;

/** Body for `PATCH /teams/:slug/lanes/:id` (lane_update / claim / handoff / resolve — one seam). */
export const UpdateLaneSchema = z.object({
  state: LaneStateSchema.optional(),
  detail: z.string().optional(),
  surface_globs: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  branch: z.string().optional(),
  /** Re-link (or clear, with null) this lane's Goal (ADR 084). */
  goal_id: z.string().nullable().optional(),
  /** Transfer ownership to this seat (lane_handoff / lane_claim sets it to the caller). */
  owner_seat: z.string().optional(),
});
export type UpdateLane = z.infer<typeof UpdateLaneSchema>;

/** Every mutating lane verb returns the lane plus any contention warnings (ADR 083 §4). */
export const LaneResultSchema = z.object({
  lane: LaneSchema,
  warnings: z.array(LaneWarningSchema),
});
export type LaneResult = z.infer<typeof LaneResultSchema>;

/** `GET /teams/:slug/lanes` — the board: lanes (optionally filtered) with live warnings annotated. */
export const LaneBoardSchema = z.object({
  lanes: z.array(LaneSchema),
  warnings: z.array(LaneWarningSchema),
});
export type LaneBoard = z.infer<typeof LaneBoardSchema>;

/**
 * `GET /teams/:slug/next` — the orientation brief (ADR 049), computed server-side so CLI + MCP render
 * one projection. The derived floor works at zero compliance: it reads the daemon's own lane/act
 * state. (The roadmap-Goal-by-wave enrichment is deferred with the Goal-source seam, ADR 048.)
 */
export const NextBriefSchema = z.object({
  /** Whose brief this is. */
  member: z.string(),
  /** Lanes you own that are live (claimed/active/blocked) — what you're carrying. */
  in_flight: z.array(LaneSchema),
  /** Your most recently shipped lanes (done), newest first — what just landed. */
  shipped: z.array(LaneSchema),
  /** Unowned lanes you could pick up, oldest first — what to start next. */
  up_next: z.array(LaneSchema),
  /** The latest `handoff` act to you or @team — the human-authored *why*, enrichment when present. */
  why: z
    .object({
      from: z.string(),
      body: z.string(),
      ts: z.number().int(),
      goal_id: z.string().nullable(),
    })
    .nullable(),
  /**
   * The next Goal to pick up (ADR 049/084): the first `planned` declared Goal by `wave`, skipping any
   * still blocked by an unshipped `depends_on`. `null` when nothing is declared (the seam is opt-in —
   * musterd's own dogfood uses `roadmap.data.ts` instead, so this is null there) or nothing qualifies.
   */
  next_goal: GoalSchema.nullable(),
});
export type NextBrief = z.infer<typeof NextBriefSchema>;
