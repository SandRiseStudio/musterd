import { z } from 'zod';

/**
 * Workspace self-heal (spec `docs/superpowers/specs/2026-09-16-workspace-self-heal-design.md`,
 * ADR 408): what a SessionStart repair wrote, skipped and left behind — posted once per repair to
 * `POST /teams/:slug/workspace/repair` and recorded as a `workspace.repaired` audit row. Counts
 * and classes only, never file contents: the row is attribution, not a copy of the workspace.
 */
export const WorkspaceRepairBodySchema = z.object({
  /** The build that did the repairing (dist stamp, ADR 135). */
  build: z.string().min(7),
  repaired: z.object({ guidance: z.number().int().min(0), hooks: z.number().int().min(0) }),
  /**
   * What was NOT repaired and why. `policy` is the permission floor (never self-healed);
   * `outside_worktree` is a hook file shared by every seat; `declined` is the folder's tombstone;
   * `checkout_behind` is ADR 168's refusal — a newer build wrote the hook.
   */
  skipped: z.array(
    z.object({
      class: z.enum(['guidance', 'hooks', 'permissions']),
      reason: z.enum(['declined', 'checkout_behind', 'outside_worktree', 'policy']),
      path: z.string().optional(),
    }),
  ),
  /** Drift still present after the repair, so a repair that leaves drift is visible as such. */
  remaining: z.object({
    guidance: z.number().int().min(0),
    hooks: z.number().int().min(0),
    permissions: z.number().int().min(0),
  }),
});
export type WorkspaceRepairBody = z.infer<typeof WorkspaceRepairBodySchema>;

/**
 * `.musterd/drift.json` — the provisioning-drift cache (spec 2026-09-16, ADR 408).
 *
 * The drift inspection reads guidance files, a hooks file and a permissions file; the adapter
 * surface that wants to REPORT drift runs on the inbox-check seam, which a busy seat takes many
 * times a minute. So the CLI — which already inspects, at session start and on the interrupt-check
 * cadence — writes what it found here, and the adapter only reads it. Counts, never paths: this
 * rides into model context, and the repair commands are the same three regardless of which file.
 *
 * `build` is the daemon's build at the time of the inspection, or the empty string when the daemon
 * was unreachable. It is a cache key, not a claim about the workspace — a reader compares it to
 * decide whether to trust the counts, and nothing else.
 */
export const DriftCacheSchema = z.object({
  inspected_at: z.number().int(),
  build: z.string(),
  guidance: z.number().int().min(0),
  hooks: z.number().int().min(0),
  permissions: z.number().int().min(0),
  /** The `musterd:self-heal` tombstone: drift is real AND nothing will repair it by itself. */
  declined: z.boolean(),
});
export type DriftCache = z.infer<typeof DriftCacheSchema>;
