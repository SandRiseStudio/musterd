/**
 * The lane vocabulary as plain TypeScript — no zod. `lanes.ts` builds its enums from these tuples
 * and re-exports every name, so the board's states and stakes have one home and the browser can
 * read a lane board without pulling a validator into its bundle (`guards.ts`).
 */

export const LANE_STATES = [
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
] as const;
export type LaneState = (typeof LANE_STATES)[number];

export const LANE_STAKES = ['low', 'normal', 'high'] as const;
export type LaneStakes = (typeof LANE_STAKES)[number];

export const LANE_STAKES_PROVENANCE = ['declared', 'defaulted'] as const;
export type LaneStakesProvenance = (typeof LANE_STAKES_PROVENANCE)[number];

/**
 * The two spellings of the post-merge acceptance stage (ADR 192). Read through this rather than
 * comparing against either name: `ready_for_review` is the ADR 169 spelling still on the wire.
 */
export function isAwaitingAcceptance(state: string): boolean {
  return state === 'awaiting_acceptance' || state === 'ready_for_review';
}

/** value-layer design: a lane in `awaiting_acceptance` longer than this warns `stale_acceptance`. */
export const ACCEPTANCE_STALE_MS = 12 * 60 * 60 * 1000;

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

/** The acceptance verdict's ack: the fact a lane moved, and the sentence explaining it. */
export interface LaneVerdictAck {
  lane: string;
  state: 'done' | 'active';
  guidance: string;
}

/**
 * Compose an acceptance verdict's ack — one text, every surface (lane 01M2KYF888).
 *
 * An `accept` replying to a `lane_review` ask IS the verdict (ADR 202): it closes a teammate's
 * lane on that send, and a seat that meant "taking this review" has judged unread work. The
 * sentence saying so used to be composed twice and identically nowhere — appended to the MCP
 * tool's `content[].text`, and written shorter in the CLI, which dropped the recovery clause
 * altogether. So the MCP surface showed it to nobody (a structured-first client renders
 * `structuredContent` and drops prose — the shape ADR 144 inc 3 encourages) and the CLI surface
 * told you what had happened without telling you what to do. It was tripped through the first of
 * those on 2026-09-16.
 *
 * Lives here, beside `askContractText`, for the same reason that one does: a sentence two
 * surfaces must agree on is protocol, not presentation.
 *
 * It names the lane inside the string because a renderer may surface the guidance and nothing
 * around it. It names `lane_update` because `decline` is NOT the undo — `applyAcceptanceVerdict`
 * only moves a lane still awaiting acceptance, and an accepted lane is `done`, so the obvious
 * correction is a silent no-op.
 */
export function laneVerdictAck(verdict: {
  lane: string;
  state: 'done' | 'active';
}): LaneVerdictAck {
  const guidance =
    verdict.state === 'done'
      ? `Lane ${verdict.lane} → done: this accept WAS the acceptance verdict (ADR 202), not an ` +
        `announcement. If you had not reviewed yet, say so — a decline on the same ask will not ` +
        `reopen it; lane_update {state: 'active'} does.`
      : `Lane ${verdict.lane} → active: this decline sent the work back to its owner.`;
  return { lane: verdict.lane, state: verdict.state, guidance };
}

/**
 * Why an acceptance submit asked nobody (ADR 404). The historical sentence "no eligible acceptor
 * is live" named both an empty room and a room full of busy / same-model / human-only seats.
 */
export const EMPTY_POOL_KINDS = ['no_live_member', 'live_ineligible'] as const;
export type EmptyPoolKind = (typeof EMPTY_POOL_KINDS)[number];

/** Exclusions that mean the seat WAS live and still was not asked. */
export const EMPTY_POOL_LIVE_EXCLUSIONS = [
  'busy',
  'not_agent',
  'unknown_grade',
  'same_model',
  'worker_unattested',
] as const;
export type EmptyPoolLiveExclusion = (typeof EMPTY_POOL_LIVE_EXCLUSIONS)[number];

export type EmptyPoolLiveSeat = { member: string; exclusion: EmptyPoolLiveExclusion };
export type EmptyPool = {
  kind: EmptyPoolKind;
  live?: EmptyPoolLiveSeat[] | undefined;
};

const NOT_A_LIVE_PEER = new Set(['self', 'service_or_observer', 'no_live_presence']);

function isLiveExclusion(ex: string): ex is EmptyPoolLiveExclusion {
  return (EMPTY_POOL_LIVE_EXCLUSIONS as readonly string[]).includes(ex);
}

/**
 * Derive the empty-pool kind from a picker snapshot. `null` when someone was selected.
 * A candidate whose exclusion is not "not live" counts as live-ineligible even if the
 * exclusion string is one this build does not list (older snapshot, newer exclusion).
 */
export function emptyPoolFromCandidates(
  selected: { reviewer: string } | null | undefined,
  candidates: ReadonlyArray<{ member: string; exclusion?: string }>,
): EmptyPool | null {
  if (selected) return null;
  const live: EmptyPoolLiveSeat[] = [];
  let sawLive = false;
  for (const c of candidates) {
    const ex = c.exclusion;
    if (!ex || NOT_A_LIVE_PEER.has(ex)) continue;
    sawLive = true;
    if (isLiveExclusion(ex)) live.push({ member: c.member, exclusion: ex });
  }
  if (!sawLive) return { kind: 'no_live_member' };
  return live.length > 0 ? { kind: 'live_ineligible', live } : { kind: 'live_ineligible' };
}
