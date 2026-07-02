import { z } from 'zod';

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
  state: LaneStateSchema,
  created_by: z.string(),
  created_at: z.number().int(),
  claimed_at: z.number().int().nullable(),
  resolved_at: z.number().int().nullable(),
  updated_at: z.number().int(),
});
export type Lane = z.infer<typeof LaneSchema>;

/** The two Phase-1 contention signals. Advisory always — a warning never fails a verb. */
export const LaneWarningSchema = z.object({
  kind: z.enum(['unmet_dependency', 'surface_overlap']),
  /** The lane the acting party touched. */
  subject: z.string(),
  /** The other lane involved (the depended-on lane / the overlapping lane). */
  with: z.string(),
  /** The other lane's owner (who gets the directed wake); null if unowned. */
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
