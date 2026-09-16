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
