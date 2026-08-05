import { z } from 'zod';
import { GoalSchema } from './goals.js';

/**
 * Coordination lanes, Phase 1 (ADR 083) — the { work-item × owner × surface } unit that makes
 * work-ownership contention-aware. Declarations only in P1: `surface_globs` + `depends_on` are the
 * whole engine; the two checks (unmet dependency, surface overlap) are **warn-only, never blocking**,
 * and git is optional throughout (`branch` is just a carried artifact label).
 */

/**
 * Lane lifecycle. `open` = unowned (claimable); `blocked`/`abandoned` are side states.
 * `awaiting_acceptance` (ADR 192; was `ready_for_review` in ADR 169) is the worker's "technically
 * complete" claim after merge — still contending (the surface stays owned until a counterpart
 * *accepts the outcome*), never terminal. `done` is the only success-terminal state; accepted-ness
 * is *derived* from the closing act's author vs the owner at close time (pinned in the
 * `lane.closed` audit row as `verified`), never stored.
 */
/**
 * The unscoped project — what a lane opened outside a git repo carries, and what every lane opened
 * before derivation existed carries. It is deliberately **wildcard** in the overlap check: an
 * unscoped lane contends with every project, and every project contends with it. A warning system
 * should fail toward a false positive, and this is what keeps a mixed-era board honest — legacy
 * lanes keep warning against everything, and the noise disappears on its own as they close.
 */
export const DEFAULT_PROJECT = 'default';

/**
 * Declared stakes for acceptance (ADR 234) — an ordered ladder, cheapest first.
 *
 * - `low` — the worker judges this not worth pulling someone off their lane for.
 * - `normal` — the default, and what every lane written before ADR 234 is read as.
 * - `high` — worth an interruption; risky surfaces (enforcement, protocol, data integrity).
 *
 * Increment 1 records the declaration and nothing reads it. What it buys is the ability to ask
 * whether declared stakes predict the answer rate **before** anything is built on the assumption
 * that they do. If they do not, the routing flip is aimed at nothing and should not ship.
 */
export const LaneStakesSchema = z.enum(['low', 'normal', 'high']);
export type LaneStakes = z.infer<typeof LaneStakesSchema>;

export const LaneStateSchema = z.enum([
  'open',
  'claimed',
  'active',
  'blocked',
  /** Canonical post-merge outcome-acceptance stage (ADR 192). */
  'awaiting_acceptance',
  /**
   * Legacy alias for `awaiting_acceptance` (ADR 169 name). Dual-accepted for fleet skew; new writes
   * use `awaiting_acceptance`. Prefer {@link isAwaitingAcceptance} over raw equality.
   */
  'ready_for_review',
  'done',
  'abandoned',
]);
export type LaneState = z.infer<typeof LaneStateSchema>;

/** True when the lane is in the post-merge outcome-acceptance stage (ADR 192), either spelling. */
export function isAwaitingAcceptance(state: string): boolean {
  return state === 'awaiting_acceptance' || state === 'ready_for_review';
}

/** Canonical state to write when entering outcome acceptance (ADR 192). */
export const AWAITING_ACCEPTANCE: LaneState = 'awaiting_acceptance';

/**
 * The two semantic state sets (ADR 169 consolidation — previously three hand-kept copies across
 * store/transport/MCP, which a new state would have tripled into drift).
 * Contending: an owned/worked lane whose surface participates in overlap warnings and the ADR 150
 * Gate A edit-guard — includes outcome acceptance (owned until accepted). Terminal: the lane's
 * active life is over.
 */
export const LANE_CONTENDING_STATES: ReadonlySet<LaneState> = new Set([
  'claimed',
  'active',
  'blocked',
  'awaiting_acceptance',
  'ready_for_review',
]);
export const LANE_TERMINAL_STATES: ReadonlySet<LaneState> = new Set(['done', 'abandoned']);

export const LaneSchema = z.object({
  id: z.string(),
  team: z.string(),
  /** Surface-space scope — contention is checked within a project, never across (ADR 068 workspace). */
  project: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  /**
   * Owning seat name; null = open/unowned. The two are one fact, not two: `state === 'open'` ⟺
   * `owner_seat === null`, enforced on every transition (`updateLane`) — claiming an open lane
   * moves it to `claimed`, and moving one back to `open` releases it. A lane that names an owner
   * while sitting open would let the board assert that someone holds work nobody is doing.
   */
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
  /**
   * Declared risk tags (ADR 169), e.g. ["user-facing", "production", "cost"]. Any tag routes the
   * review ask human-first. Declared at open/update, never inferred from surfaces. Defaulted so a
   * newer client parses an older daemon's lanes (skew-tolerant, the ADR 148 posture).
   */
  risk: z.array(z.string()).default([]),
  /**
   * Declared **stakes** for acceptance (ADR 234) — how much this change is worth someone's eyes.
   *
   * Deliberately NOT `risk`. `risk` already has a consumer that routes the ask human-first on any
   * tag, and a second consumer with opposite needs on one value is the shared-predicate trap named
   * in ADR 225: "low stakes" cannot be said in `risk` without either colliding with its empty
   * default or accidentally demanding a human. Each consumer states its own need.
   *
   * Declared, never inferred from the surface — the counterpoint ryder insisted on carrying with
   * nick's proposal is that surface complexity predicts review COST, not review VALUE (the two most
   * valuable acceptance reviews of 2026-08-04 were both on docs, and each changed the artifact). So
   * a filetype rule is the wrong knife; the worker declares.
   *
   * Defaults to `normal` on purpose. An opt-IN-to-acceptance design fails silent — forgetting to
   * declare would drop a lane below the line by inaction. Forgetting must cost an ask, never a
   * review.
   *
   * **Increment 1 records this and changes nothing else.** No routing consumes it yet; the flip is
   * gated on what the label measures.
   */
  stakes: LaneStakesSchema.default('normal'),
  /**
   * The worker's merge attestation, captured at `awaiting_acceptance` (ADR 192 / formerly
   * `ready_for_review`) so the acceptor's close carries the *worker's* claim verbatim into
   * `git.pr_merged`. Null until `lane_submit`; defaulted for older-daemon skew.
   */
  merged: z
    .object({
      pr: z.number().int().optional(),
      sha: z.string().optional(),
      authorized_by: z.string().optional(),
    })
    .nullable()
    .default(null),
  state: LaneStateSchema,
  /**
   * Board-projection annotation (ADR 169/191), never stored: for a `done` lane, whether the close
   * was a counterpart *acceptance* (derived from the `lane.closed` audit row's closer vs
   * owner-at-close). Wire name stays `verified`; UI copy is accepted / unconfirmed (ADR 192).
   * Absent on non-terminal lanes, on older daemons, and on lanes closed before the audit existed —
   * absent means "unknown", and the UI says nothing rather than guessing.
   */
  verified: z.boolean().optional(),
  created_by: z.string(),
  created_at: z.number().int(),
  claimed_at: z.number().int().nullable(),
  resolved_at: z.number().int().nullable(),
  updated_at: z.number().int(),
});
export type Lane = z.infer<typeof LaneSchema>;

/**
 * The lane contention + staleness signals. Advisory always — a warning never fails a verb.
 * Phase-1 (ADR 083): `unmet_dependency`, `surface_overlap`. Increment 3 (ADR 111 / ADR 088 §5) adds the
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
  /** Declared risk tags (ADR 169) — any tag routes the review ask human-first. */
  risk: z.array(z.string()).optional(),
  /** Declared acceptance stakes (ADR 234). Omitted ⇒ `normal`; nothing routes on it yet. */
  stakes: LaneStakesSchema.optional(),
  claim: z.boolean().optional(),
});
export type OpenLane = z.infer<typeof OpenLaneSchema>;

/** Body for `PATCH /teams/:slug/lanes/:id` (lane_update / claim / handoff / resolve — one seam). */
export const UpdateLaneSchema = z.object({
  state: LaneStateSchema.optional(),
  detail: z.string().optional(),
  /**
   * Re-scope this lane's surface-space. `project` is stamped at open from the opener's workspace, so
   * a lane opened from the wrong checkout (or before derivation existed) had no way back — and an
   * immutable field with no escape hatch makes a mis-stamp permanent.
   */
  project: z.string().optional(),
  surface_globs: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  branch: z.string().optional(),
  /** Re-link (or clear, with null) this lane's Goal (ADR 084). */
  goal_id: z.string().nullable().optional(),
  /** Transfer ownership to this seat (lane_handoff / lane_claim sets it to the caller). */
  owner_seat: z.string().optional(),
  /** Declared risk tags (ADR 169) — any tag routes the review ask human-first. */
  risk: z.array(z.string()).optional(),
  /**
   * Re-declare acceptance stakes (ADR 234). Editable after open on purpose: what a change is worth
   * someone's eyes is often only clear once the work exists, and a declaration you cannot revise is
   * one people learn to set defensively.
   */
  stakes: LaneStakesSchema.optional(),
  /**
   * Merge attestation (ADR 109), meaningful on a terminal move of a branch-carrying lane — or, under
   * two-stage close (ADR 192), captured at `awaiting_acceptance` (the worker's claim) and persisted
   * on the lane so a counterpart's later accept carries it. Attested, never verified — recorded to
   * the audit log as `git.pr_merged`.
   */
  merged: z
    .object({
      pr: z.number().int().optional(),
      sha: z.string().optional(),
      authorized_by: z.string().optional(),
    })
    .optional(),
});
export type UpdateLane = z.infer<typeof UpdateLaneSchema>;

/**
 * Every mutating lane verb returns the lane plus any contention warnings (ADR 083 §4). Under
 * two-stage close (ADR 192) a patch that enters `awaiting_acceptance` additionally reports the
 * acceptor routing: who the ask went to, or that self-close is sanctioned (no eligible acceptor live).
 */
export const LaneResultSchema = z.object({
  lane: LaneSchema,
  warnings: z.array(LaneWarningSchema),
  review: z
    .object({
      reviewer: z.string().optional(),
      route: z.enum(['human_admin', 'cross_family']).optional(),
      self_close_sanctioned: z.boolean().optional(),
    })
    .optional(),
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
  /** Lanes you own that are live (claimed/active/blocked/awaiting_acceptance) — what you're carrying. */
  in_flight: z.array(LaneSchema),
  /** Your most recently shipped lanes (done), newest first — what just landed. */
  shipped: z.array(LaneSchema),
  /** Unowned lanes you could pick up, oldest first — what to start next. */
  up_next: z.array(LaneSchema),
  /**
   * Verdicts someone is waiting on from YOU (ADR 233): lanes still in the acceptance stage whose
   * review ask was routed to this seat. Oldest ask first — the longest wait is the one closest to
   * being closed unverified.
   *
   * Here because the ask alone does not survive being busy. Measured over the dogfood ledger: half
   * the unverified self-closes had the named reviewer ONLINE for ~40 minutes across an 18-hour
   * window and still never answering — *more* awake time than the reviewers who did answer
   * (0.67h vs 0.22h). Having time was not the problem; being reminded was. The ask lands once in an
   * inbox that scrolls, and nothing re-surfaces it, so a seat that goes heads-down loses it.
   *
   * Not `in_flight`: those are lanes you OWN. A review is owed on someone else's work, and folding
   * the two would make "what am I carrying" mean two different things.
   */
  owed_reviews: z
    .array(
      z.object({
        /** The lane awaiting your verdict. */
        lane: LaneSchema,
        /** Who is waiting — the lane's owner, as the ask's sender. */
        from: z.string(),
        /** The ask to answer: pass as `reply_to` so the verdict binds to this lane and no other. */
        ask_id: z.string(),
        /** When it was asked, so the reader can see how long someone has been waiting. */
        ts: z.number().int(),
      }),
    )
    .default([]),
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
