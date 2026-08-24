import { z } from 'zod';
import { GoalSchema } from './goals.js';

/**
 * Coordination lanes, Phase 1 (ADR 083) — the { work-item × owner × scope } unit that makes
 * work-ownership contention-aware. Declarations only in P1: `scope` + `depends_on` are the
 * whole engine; the two checks (unmet dependency, scope overlap) are **warn-only, never blocking**,
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

/** Who set a lane's stakes (ADR 244) — see {@link LaneSchema.shape.stakes_provenance}. */
export const LaneStakesProvenanceSchema = z.enum(['declared', 'defaulted']);
export type LaneStakesProvenance = z.infer<typeof LaneStakesProvenanceSchema>;

/**
 * One admin-set default-stakes rule (ADR 244): lanes whose declared surface lies entirely under
 * `surface` open at `stakes` unless the worker says otherwise.
 *
 * This is the surface-path rule ADR 234 rejected, and it is admissible now for one reason worth
 * stating rather than sliding past: ADR 234 rejected the system **inferring** value from a diff,
 * because surface complexity predicts review COST, not review VALUE. An admin declaring "on my team,
 * web lanes start low" is not an inference — it is an accountable human making a revocable,
 * attributable, visible choice, which is the kind of judgement ADR 234 wants stakes to carry. The
 * rule did not change; the actor did.
 */
export const StakesDefaultSchema = z.object({
  /**
   * A surface prefix, written as a glob for readability (`packages/web/**`). Matched as a PREFIX,
   * not by a glob engine — a predictable rule an admin can reason about beats an expressive one they
   * cannot, and this value silently changes who reviews their team's work.
   */
  surface: z.string().min(1),
  stakes: LaneStakesSchema,
});
export type StakesDefault = z.infer<typeof StakesDefaultSchema>;

/**
 * Does this policy give the lane a default, and which? First match wins, so an admin can order
 * specific rules ahead of broad ones.
 *
 * **Every** declared glob must fall under the rule, not merely one — and that asymmetry is the
 * safety property. A lane touching `packages/web/**` AND `packages/server/**` is not a web lane; if
 * `any` matched, a worker could exempt a server change by mentioning a web file beside it, and the
 * exemption would be one glob away from anything. A lane declaring NO surface matches nothing and
 * keeps `normal`: a lane that did not say where it works has not earned a surface-based default.
 */
export function resolveStakesDefault(
  rules: readonly StakesDefault[],
  scope: readonly string[],
): StakesDefault | undefined {
  if (scope.length === 0) return undefined;
  return rules.find((rule) => {
    // `packages/web/**`, `packages/web/` and `packages/web` all mean "under packages/web". Normalize
    // to a prefix ending at a path boundary: without that last step `packages/web` also matches
    // `packages/webhooks`, and an admin who wrote the shortest legible form would silently widen
    // their own rule across a sibling package. A rule that changes who reviews the team's work has
    // to mean exactly what it looks like it means.
    const prefix = rule.surface.replace(/\*+$/, '').replace(/\/$/, '') + '/';
    return scope.every((g) => g.startsWith(prefix));
  });
}

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

/**
 * Why a lane's close landed the way it did (ADR 283) — the vocabulary the `lane.closed` audit row
 * has recorded since ADR 217/229/234, lifted onto the wire so a reader can act on it.
 *
 * The order is the ladder `laneClose.ts` walks, and the grouping is the one that matters to a
 * reader: the first two are settled outcomes, the middle three mean NOBODY WAS ASKED, and the last
 * three mean SOMEBODY WAS ASKED AND DID NOT ANSWER. Any new member must be added deliberately —
 * an unrecognised value is dropped by the projection rather than passed through, so a future
 * daemon's vocabulary degrades to "unknown" instead of leaking a string this build cannot explain.
 */
export const CloseReasonSchema = z.enum([
  /** A counterpart accepted it. The only reason that means `verified: true`. */
  'counterpart_confirm',
  /** The owner closed their own lane, no acceptance stage involved. */
  'self_close',
  /** Never entered acceptance: declared `low` stakes and not drawn into the sample (ADR 234). */
  'acceptance_exempt',
  /** The picker found no eligible counterpart — the sanctioned degradation (ADR 172). */
  'no_candidate',
  /** A risk tag REQUIRED a human and none was live — a requirement with no one to meet it. */
  'human_review_missed',
  /** Asked, and the wait ran past the promise (ADR 217). */
  'review_timeout',
  /** Asked, and the owner closed it themselves before the promise elapsed (ADR 217). */
  'review_cut_short',
  /** Asked, and the promise itself was never knowable — abstains on the elapsed claim (ADR 217). */
  'review_unanswered',
  /** The ADR 229 24h sweep closed it. The clock, not a seat — see `ask_outcome` on the audit row. */
  'review_swept',
  /** Abandoned rather than shipped. */
  'abandoned',
]);
export type CloseReason = z.infer<typeof CloseReasonSchema>;

/**
 * What to TELL a reader about an unaccepted close (ADR 283), or `null` where the reason adds
 * nothing to the word already on screen.
 *
 * Copy lives here, once, for the same reason the derivation does (ADR 084): the board, the brief,
 * and the CLI drifted apart on `verified` for two ADRs, and the fix was one projection rather than
 * three renderers agreeing by luck. Each phrase is written to imply its OWN next move — the
 * distinction is only worth a wire field if a reader can act differently on each half, so "chase a
 * person" and "look at the roster" have to be legible from the sentence alone.
 *
 * `counterpart_confirm` and `abandoned` return `null`: the first is what `accepted` already says,
 * and the second is already the whole story. Repeating them would make the annotation noise on the
 * majority of lanes and train readers to skip it on the minority where it carries the news.
 */
export function closeReasonCopy(reason: CloseReason): string | null {
  switch (reason) {
    case 'counterpart_confirm':
    case 'abandoned':
      return null;
    case 'self_close':
      return 'closed by its own owner';
    case 'acceptance_exempt':
      return 'no ask sent, by design — declared low stakes';
    case 'no_candidate':
      return 'nobody was asked — no eligible counterpart';
    case 'human_review_missed':
      return 'nobody was asked — the required human was never live';
    case 'review_timeout':
      return 'asked, and the wait ran out';
    case 'review_cut_short':
      return 'asked, then closed before the wait elapsed';
    case 'review_unanswered':
      return 'asked, and never answered';
    case 'review_swept':
      return 'swept by the 24h clock, not by a seat';
  }
}

/** True when the lane is in the post-merge outcome-acceptance stage (ADR 192), either spelling. */
export function isAwaitingAcceptance(state: string): boolean {
  return state === 'awaiting_acceptance' || state === 'ready_for_review';
}

/** value-layer design: a lane in `awaiting_acceptance` longer than this warns `stale_acceptance`. */
export const ACCEPTANCE_STALE_MS = 12 * 60 * 60 * 1000;

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

/**
 * ADR 296 tier 2: a lane's paths are its **scope**; `surface_globs` is the pre-rename wire token
 * (ADR 296 §1 narrows `surface` to where a member touches the team). Adopt the legacy key on read,
 * and keep BOTH keys populated on the full Lane shape: a client one epoch behind still requires
 * `surface_globs`, so a daemon serializing a parsed lane never strands it (the ADR 138 skew
 * posture). `scope` wins when both arrive and the mirror is normalized to it. The mirror drops in
 * a later epoch, on-touch — no calendar bound.
 */
function adoptLegacyScopeKey(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const rec = raw as Record<string, unknown>;
  if ('scope' in rec) return { ...rec, surface_globs: rec.scope };
  if ('surface_globs' in rec) return { ...rec, scope: rec.surface_globs };
  return raw;
}

/**
 * Client-side skew guard for the same rename: an epoch-13 daemon's request schema silently DROPS
 * the unknown `scope` key — the call succeeds with an empty scope, the exact empty-surface trap the
 * MCP coercion layer documents. A new client therefore dual-sends the legacy mirror alongside
 * `scope` until the fleet is past the rename; a new daemon adopts `scope` (it wins on read), an old
 * one reads the mirror. Drops with the mirror, on-touch.
 */
export function mirrorLegacyScopeOnSend<T>(body: T): T {
  if (body && typeof body === 'object' && 'scope' in body) {
    const rec = body as Record<string, unknown>;
    if (rec.scope !== undefined) return { ...rec, surface_globs: rec.scope } as T;
  }
  return body;
}

/** Request-body variant of {@link adoptLegacyScopeKey}: canonical `scope` only, no mirror — the
 *  daemon is the only reader of these bodies and it is never behind its own build. */
function adoptLegacyScopeInput(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'surface_globs' in raw && !('scope' in raw)) {
    const { surface_globs, ...rest } = raw as Record<string, unknown>;
    return { ...rest, scope: surface_globs };
  }
  return raw;
}

export const LaneSchema = z.preprocess(
  adoptLegacyScopeKey,
  z.object({
    id: z.string(),
    team: z.string(),
    /** Surface-space scope — contention is checked within a project, never across (ADR 068 workspace). */
    project: z.string(),
    title: z.string(),
    detail: z.string().nullable(),
    /**
     * What sort of lane this is. `null` = ordinary work lane; `'incident'` = daemon-opened
     * shared-blocker lane (spec 2026-08-14). Immutable after open on purpose — it is deliberately
     * absent from `UpdateLaneSchema`: an incident that stops being one is resolved, never relabeled.
     * Optional (not defaulted) so pre-v41 fixtures and older daemons stay assignable — consumers only
     * ever ask `kind === 'incident'`, and absence answers that correctly.
     */
    kind: z.enum(['incident']).nullable().optional(),
    /**
     * Owning seat name; null = open/unowned. The two are one fact, not two: `state === 'open'` ⟺
     * `owner_seat === null`, enforced on every transition (`updateLane`) — claiming an open lane
     * moves it to `claimed`, and moving one back to `open` releases it. A lane that names an owner
     * while sitting open would let the board assert that someone holds work nobody is doing.
     */
    owner_seat: z.string().nullable(),
    /** Assignment hint (backend/frontend/…); advisory only in P1. */
    role: z.string().nullable(),
    /** Declared scope, e.g. ["packages/server/src/store/**"] — the paths this lane touches, and the
     *  overlap-check input. Canonical token (ADR 296; was `surface_globs`). */
    scope: z.array(z.string()),
    /** Deprecated mirror of {@link scope} — the pre-ADR-296 wire token. The schema keeps it populated
     *  (see {@link adoptLegacyScopeKey}) so epoch-13 clients parse; consumers must read `scope`. */
    surface_globs: z.array(z.string()).optional(),
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
     * WHO put that value there (ADR 244) — `declared` when a person or seat said it, `defaulted` when
     * a team policy wrote it at `lane_open`.
     *
     * This exists to protect ADR 234's rollback test, which asks whether **declared** stakes predict
     * the answer rate. Once an admin policy can write `stakes: 'low'`, a single `low` bucket pools two
     * completely different claims — "the worker judged this small" and "policy assumed this class is
     * small" — and the Eval could no longer tell them apart. It would fail silently and permanently,
     * which is the same confound class as the acceptor monoculture except arriving through a feature
     * instead of an accident. So the two are separated at the source, and the Eval splits on it.
     *
     * `declared` is the honest default for everything else, including a lane that declared nothing:
     * ADR 234 §2 already ruled that absence IS the declaration, so an unstated `normal` is the
     * worker's answer, not a policy's. `defaulted` is written ONLY where a policy actually fired.
     */
    stakes_provenance: LaneStakesProvenanceSchema.default('declared'),
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
        /**
         * Seat-side verification tier stamped by `lane_submit` (merge-verified submit):
         * `ancestor` (SHA reachable from origin/main — landed), `unknown_object` (SHA not in the
         * submitting worktree's repo — cross-repo lane), `fetch_failed` (could not refresh
         * origin/main — abstained), `unattested` (no SHA given). `not_ancestor` never appears
         * here: it is refused at submit, before any lane mutation. A z.string rather than an
         * enum so a newer client's tier parses instead of rejecting; consumers compare against
         * {@link MERGE_VERIFICATION_TIERS} and say nothing on values they don't know.
         */
        verification: z.string().optional(),
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
    /**
     * Board-projection annotation (ADR 283), never stored: for a `done` lane, WHY it closed the way
     * it did — read from the same `lane.closed` audit row `verified` is derived from.
     *
     * `verified: false` is two opposite situations wearing one word, and the response to each is the
     * response the other one would waste. `review_timeout` / `review_unanswered` / `review_cut_short`
     * mean a counterpart was asked and did not answer — go find a person. `no_candidate` /
     * `human_review_missed` mean no ask was ever sent because the roster held nobody eligible — a
     * degradation nobody is at fault for, answered by looking at who is on the team. Measured
     * 2026-08-19 over 344 closes, both halves are populous (40 + 9 against 23 + 16 + 2) and neither
     * reached a reader.
     *
     * Absent means unknown, exactly as `verified` does: a close predating the reason, a lane that
     * never closed, an older daemon, or a value this build does not recognise. A consumer that
     * defaults the absent case to any particular reason re-creates the defect this field fixes.
     */
    close_reason: CloseReasonSchema.optional(),
    created_by: z.string(),
    created_at: z.number().int(),
    claimed_at: z.number().int().nullable(),
    resolved_at: z.number().int().nullable(),
    updated_at: z.number().int(),
  }),
);
export type Lane = z.infer<typeof LaneSchema>;

/**
 * The lane contention + staleness signals. Advisory always — a warning never fails a verb.
 * Phase-1 (ADR 083): `unmet_dependency`, `surface_overlap`. Increment 3 (ADR 111 / ADR 088 §5) adds the
 * two staleness signals the interrupt line can't catch: `stale_plan` (the lane's own Goal moved epoch
 * since it was claimed) and `stale_dependency` (a lane it builds on had its Goal move). Both are
 * owner-directed, never broadcast — directory-based invalidation over the goal_id join + depends_on edge.
 * goals-front-door design adds `no_goal` — a contending lane on no goal while the team has unshipped
 * goals; advisory, owner-null, never woken.
 */
export const LaneWarningSchema = z.object({
  kind: z.enum([
    'unmet_dependency',
    'surface_overlap',
    'stale_plan',
    'stale_dependency',
    'no_goal',
    /** value-layer design: a lane waiting on acceptance past ACCEPTANCE_STALE_MS — review debt
     *  made visible. Advisory like `no_goal`: owner null, never a directed wake. */
    'stale_acceptance',
  ]),
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
export const OpenLaneSchema = z.preprocess(
  adoptLegacyScopeInput,
  z.object({
    title: z.string().min(1),
    detail: z.string().optional(),
    project: z.string().optional(),
    role: z.string().optional(),
    /** The paths this lane touches (ADR 296; legacy `surface_globs` adopted on read). */
    scope: z.array(z.string()).optional(),
    depends_on: z.array(z.string()).optional(),
    branch: z.string().optional(),
    /** Link this lane to a Goal at open (ADR 084) — the id `musterd next` groups + derives status by. */
    goal_id: z.string().optional(),
    /** Declared risk tags (ADR 169) — any tag routes the review ask human-first. */
    risk: z.array(z.string()).optional(),
    /** Declared acceptance stakes (ADR 234). Omitted ⇒ `normal`; nothing routes on it yet. */
    stakes: LaneStakesSchema.optional(),
    /** Lane kind (spec 2026-08-14): only the daemon sets 'incident'; omitted ⇒ ordinary lane. */
    kind: z.enum(['incident']).optional(),
    claim: z.boolean().optional(),
  }),
);
export type OpenLane = z.infer<typeof OpenLaneSchema>;

/** Body for `PATCH /teams/:slug/lanes/:id` (lane_update / claim / handoff / resolve — one seam). */
export const UpdateLaneSchema = z.preprocess(
  adoptLegacyScopeInput,
  z.object({
    state: LaneStateSchema.optional(),
    /**
     * Correct the title (ADR 240). Same reasoning as `project` below, applied to the field a reader
     * sees FIRST: a lane opened with a title that misstates the work had no way back, and the only
     * available correction was a note inside the detail — which reaches nobody who decides, from the
     * board, not to open the lane. Forward-only: notification bodies already sent keep the title they
     * were sent with, because they are history. `min(1)` — an empty title is worse than a wrong one.
     */
    title: z.string().min(1).optional(),
    detail: z.string().optional(),
    /**
     * Re-scope this lane's surface-space. `project` is stamped at open from the opener's workspace, so
     * a lane opened from the wrong checkout (or before derivation existed) had no way back — and an
     * immutable field with no escape hatch makes a mis-stamp permanent.
     */
    project: z.string().optional(),
    /** Re-declare the paths this lane touches (ADR 296; legacy `surface_globs` adopted on read). */
    scope: z.array(z.string()).optional(),
    depends_on: z.array(z.string()).optional(),
    branch: z.string().optional(),
    /** Re-link (or clear, with null) this lane's Goal (ADR 084). */
    goal_id: z.string().nullable().optional(),
    /** Transfer ownership to this seat (lane_handoff / lane_claim sets it to the caller). */
    owner_seat: z.string().optional(),
    /**
     * Why this handoff (ADR 243) — carried into the body of the `handoff` act the transfer already
     * emits, never stored on the lane. `lane_handoff` had no way to say anything, so explaining a
     * handoff took a SECOND act, and that act named no lane and had to derive one from the lanes the
     * sender still held — which is precisely the set the transfer just removed the right answer from.
     * The note exists so the explanation and the correct lane travel in one act instead of two.
     *
     * Meaningful only alongside an `owner_seat` that moves the lane to someone else; ignored
     * otherwise rather than rejected, so a client that always sends it is not punished for it.
     */
    handoff_note: z.string().max(4000).optional(),
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
        /** Seat-side verification tier — see the field's doc on {@link LaneSchema}. */
        verification: z.string().optional(),
      })
      .optional(),
  }),
);
export type UpdateLane = z.infer<typeof UpdateLaneSchema>;

/**
 * The verification tiers a submit can persist (merge-verified submit). `not_ancestor` is
 * deliberately not a member: it is a refusal outcome at `lane_submit`, never a stored state.
 */
export const MERGE_VERIFICATION_TIERS = [
  'ancestor',
  'unknown_object',
  'fetch_failed',
  'unattested',
] as const;
export type MergeVerification = (typeof MERGE_VERIFICATION_TIERS)[number];

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
      /**
       * The lane was ALREADY awaiting acceptance: this is a report of the standing state (who was
       * asked at the original submit), not a fresh routing decision. Set on repeat submits — e.g.
       * recording the merge SHA after the PR lands, which is the normal flow. Consumers must never
       * read a standing report's missing reviewer as "no eligible acceptor is live": that misread
       * sanctioned self-close against lanes whose acceptor had a pending ask (2026-08-05), the
       * premature unverified close ADR 235 measured 20-for-20.
       */
      standing: z.boolean().optional(),
      /** ADR 234 increment 2: the submit was acceptance-exempt (declared low stakes) — no ask
       *  exists and none is owed; self-close is the designed path, not a degradation. */
      acceptance_exempt: z.boolean().optional(),
      /**
       * ADR 235: this team has an acceptance backstop, so an unanswered lane gets collected rather
       * than hanging — which is what makes "leave it with them" safe advice instead of a way to
       * strand work. Present only when an acceptor was actually asked AND the team armed
       * `loops.sweep`.
       *
       * Absent means "no backstop to rely on", which is also what an older daemon sends — so the
       * fallback is the pre-235 advice, and the degradation is toward the safe answer rather than
       * toward telling a seat to wait for a sweep that will never run.
       */
      backstop: z
        .object({ armed: z.boolean(), grace_ms: z.number().int().nonnegative() })
        .optional(),
    })
    .optional(),
  /** Advisory lines appended to this caller's result only (value-layer design: the ship nudge) —
   *  rendered to the actor, never a wake, never stored. */
  notices: z.array(z.string()).optional(),
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
  /**
   * goals-front-door design: the team's unshipped Goals, wave-ordered (`in-flight` before `planned`
   * at equal wave) — the brief leads with the missions, not the lane pool. `.default([])` keeps a
   * brief from an older daemon parseable.
   */
  goals: z.array(GoalSchema).default([]),
  /**
   * value-layer design: the team's oldest lanes waiting on acceptance (cap 3, oldest first) —
   * review debt surfaced as candidate work for ANY seat, not just the routed acceptor
   * (`owed_reviews` is the directed slice; this is the ambient one). Absent when nothing waits.
   */
  review_debt: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        owner: z.string().nullable(),
        waited_ms: z.number().int().nonnegative(),
        /**
         * True when the submit found NO eligible reviewer and asked nobody. ADR 188/253 refuse to
         * route `same_model` and ungradeable seats, so on a same-model monoculture every candidate
         * is refused and the lane enters the queue unrouted. Without this the entry is
         * indistinguishable from one whose named reviewer is merely slow — and the two want
         * opposite responses: chase a person, or notice that no person exists.
         * `.default(false)` keeps a brief from an older daemon parseable.
         */
        no_candidate: z.boolean().default(false),
        /**
         * True when the lane's merge attestation carries no SHA — under merge-verified
         * submit nothing has landed, so there is NOTHING TO ACCEPT YET: the wait is on the
         * author's merge button, not a reviewer (dolly's #961/#963, 2026-08-21). Only
         * grandfathered lanes and older clients can reach this state; new submits are
         * refused unlanded. `.default(false)` keeps older-daemon briefs parseable.
         */
        unlanded: z.boolean().default(false),
      }),
    )
    .optional(),
  /**
   * How many lanes are waiting on acceptance in total — `review_debt` shows at most the oldest 3.
   * A window with no total reads as the whole queue: clear the three on offer, look again, and more
   * appear with nothing having said they were there. `.default(0)` keeps an older daemon's brief
   * parseable, and 0 with a non-empty `review_debt` means "this daemon does not count".
   */
  review_debt_total: z.number().int().nonnegative().default(0),
  /**
   * Incident convergence inc 1 (spec 2026-08-14 §4): open `kind:'incident'` lanes, oldest first.
   * The brief LEADS with these — most of the measured waste was seats starting sessions into a red
   * they assumed was theirs. `.default([])` keeps a brief from an older daemon parseable.
   */
  incidents: z
    .array(
      z.object({
        /** The incident lane id — claim it or park behind it. */
        lane: z.string(),
        /** The clustered gate (the lane title minus the derived prefix). */
        gate: z.string(),
        /** Who carries it; null = unclaimed, any seat may take it. */
        owner_seat: z.string().nullable(),
        /** Lane created_at — lets the renderer say how long it has been open. */
        opened_at: z.number().int(),
        /**
         * When the claim window shuts and the incident falls to `fallback_role` (ADR 271). Null once
         * someone owns it, or when the team disabled convergence — in both cases there is no
         * countdown to state. A seat reading the banner is deciding whether to pick this up, and
         * "unclaimed" alone does not say whether that decision is still theirs to make.
         * `.optional()` so a brief from a pre-ADR-271 daemon still parses.
         */
        claim_closes_at: z.number().int().nullable().optional(),
        /** Who it falls to at that moment. Null when nobody holds the role — an incident that will
         *  stay unowned, which the seat reading this should know before assuming it is handled. */
        fallback_role: z.string().nullable().optional(),
      }),
    )
    .default([]),
});
export type NextBrief = z.infer<typeof NextBriefSchema>;
