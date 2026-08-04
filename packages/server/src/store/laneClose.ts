import { type Lane, isAwaitingAcceptance, reviewGrade } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { appendAudit, peerReviewGradeOf, reviewRouting } from './audit.js';
import { memberIsHuman, memberModelByName, workerFamily } from './review.js';

/** The closing seat, as much of it as the audit needs. */
export interface Closer {
  name: string;
  kind: string;
}

/** A merge attestation supplied by the closing patch itself (ADR 109), if any. */
export interface MergedAttestation {
  pr?: number | undefined;
  sha?: string | undefined;
  authorized_by?: string | undefined;
}

/**
 * Write the audit rows a lane's terminal edge owes: `lane.closed` always, and `git.pr_merged` when a
 * branch landed.
 *
 * This lives in one place on purpose. Verified-ness, the close `reason`, the ADR 172/173 abstentions
 * and the ADR 188 review grade are all DERIVED here rather than stored, and there are now two ways to
 * close a lane — the board's PATCH and an acceptor's `accept` act. A second copy of this derivation
 * would not stay a copy for long, and the first divergence would be silent: the two paths would
 * simply disagree about whether the same close was verified.
 *
 * Pure db writes, no envelope routing — each caller announces the close on its own surface, which is
 * also what keeps this importable from both the transport and the protocol layer without a cycle.
 */
export function recordLaneClose(
  db: Database,
  teamId: string,
  closer: Closer,
  before: Lane,
  lane: Lane,
  mergedFromPatch?: MergedAttestation,
): void {
  // ADR 169: every terminal edge writes lane.closed, and verified-ness is DERIVED here — never
  // stored on the lane. Verified ⟺ done + the closer is a different seat than the owner at close
  // time (pinned in this row so post-close handoffs can't flip the verdict). reason distinguishes
  // the counterpart confirm from the two honest self-close shapes.
  const ownerAtClose = before.owner_seat;
  const verified = lane.state === 'done' && ownerAtClose !== null && closer.name !== ownerAtClose;
  // ADR 169/172: what the ready edge recorded — routed-or-not, and whether the lane's risk made a
  // human review REQUIRED. Read once; feeds both the reason and the missed flag.
  const routing = isAwaitingAcceptance(before.state)
    ? reviewRouting(db, teamId, lane.id)
    : {
        routed: undefined as boolean | undefined,
        human_required: undefined as boolean | undefined,
        promised_ms: undefined as number | undefined,
      };
  // ADR 217: how long the owner actually left the lane in review. Same approximation ADR 169 uses
  // for `time_in_review_ms` — entering review was the lane's last update before the close — and it
  // is computed once so the reason and the recorded duration can never disagree.
  const timeInReviewMs = isAwaitingAcceptance(before.state)
    ? Date.now() - before.updated_at
    : undefined;
  // ADR 217: grade the wait against the window the acceptor was PROMISED, not against a fixed
  // number. `undefined` on either side abstains — see `reviewTimeoutReason`.
  const waitVerdict =
    routing.promised_ms !== undefined && timeInReviewMs !== undefined
      ? timeInReviewMs >= routing.promised_ms
        ? ('review_unanswered' as const)
        : ('review_cut_short' as const)
      : ('review_timeout' as const);
  // ADR 172: even a verified close can miss the requirement — an agent counterpart confirming a
  // risky lane is a real review, but not the HUMAN one the risk demanded. `=== true`, never
  // truthiness: an abstaining read must not assert the flag (ADR 173 clause 3 — a consumer that
  // folds `unknown` back into falsy re-creates the defect here, where it is invisible). A lane that
  // never entered review abstains for a different and equally honest reason: nothing recorded a
  // requirement because nothing was ever asked.
  const humanReviewMissed =
    routing.human_required === true &&
    lane.state === 'done' &&
    // kind-only, not `|| is_admin`: admins can only be humans (ADR 172), and a stale agent-admin
    // row must not read as having satisfied a human-review requirement.
    closer.kind !== 'human';
  appendAudit(db, teamId, {
    actor: closer.name,
    action: 'lane.closed',
    target: lane.id,
    result: 'allow',
    detail: {
      lane: lane.id,
      state: lane.state,
      closed_by: closer.name,
      owner_at_close: ownerAtClose,
      verified,
      reason:
        lane.state === 'abandoned'
          ? 'abandoned'
          : verified
            ? 'counterpart_confirm'
            : isAwaitingAcceptance(before.state)
              ? // A timeout means somebody was asked and did not answer. When the picker found
                // nobody, no ask was ever sent, and calling that a timeout is simply false. Two
                // no-ask shapes (ADR 172): an empty cross-family pool is the sanctioned
                // `no_candidate` degradation; a risky lane whose REQUIRED human was never live is
                // `human_review_missed` — a requirement with no one to meet it, not a shrug.
                // `undefined` routing (a lane that entered review before the outcome was recorded)
                // keeps the old label rather than inventing a verdict about the past.
                routing.routed === false
                ? // Same discipline one level down: only a RECORDED requirement earns the
                  // `human_review_missed` label. A row that abstains keeps the older, weaker
                  // `no_candidate` — the label it would have carried before the requirement was
                  // ever recorded — rather than a verdict about a past that never wrote one down.
                  routing.human_required === true
                  ? 'human_review_missed'
                  : 'no_candidate'
                : // ADR 217: an ask WAS sent and the owner closed it themselves — but "timeout" was
                  // asserting an elapsed wait nobody had measured. 11 of the first 18 such closes
                  // happened inside five minutes, the fastest after 8 seconds, while the median
                  // successful confirm took 22 minutes. The reason now says which of the two
                  // opposite failures this was, and abstains when the promise is unknowable.
                  waitVerdict
              : 'self_close',
      // ADR 172: flagged even on a verified close — an agent counterpart's confirm on a risky lane
      // is a real review, but not the human one the risk tag demanded.
      ...(humanReviewMissed ? { human_review_missed: true } : {}),
      // ADR 173 clause 4: an abstention has to be COUNTABLE, or the counter-metric's silence is
      // indistinguishable from a clean zero. Recorded only where the question was live — a lane
      // that entered review, whose ready row could not tell us what it required.
      ...(isAwaitingAcceptance(before.state) && routing.human_required === undefined
        ? { human_required_unknown: true }
        : {}),
      worker_family: ownerAtClose ? workerFamily(db, teamId, ownerAtClose) : null,
      ...(verified ? { reviewer_family: workerFamily(db, teamId, closer.name) } : {}),
      // ADR 188 two-stage: which peer review a RISKY lane actually got — the newest
      // lane.review_peer_confirmed row's grade, or 'none'. Only written on risky lanes; the human
      // half of the pair stays `human_review_missed`, derived exactly as before.
      ...(lane.risk.length > 0 && isAwaitingAcceptance(before.state)
        ? { peer_review: peerReviewGradeOf(db, teamId, lane.id) }
        : {}),
      // ADR 188: the close edge finally CHECKS what the confirm was worth, for routed and voluntary
      // confirms alike. `verified` keeps its meaning (a different seat confirmed); the grade rides
      // beside it so a same-model confirm can never imply diversity it does not have. A human
      // confirmer grades 'human' (cross-family by construction). When a model is unattested at
      // close the grade abstains — and the abstention is COUNTED (`review_grade_unknown`, ADR 173)
      // rather than left indistinguishable from silence.
      ...(verified
        ? (() => {
            if (memberIsHuman(db, teamId, closer.name)) return { review_grade: 'human' };
            const g = reviewGrade(
              ownerAtClose ? memberModelByName(db, teamId, ownerAtClose) : null,
              memberModelByName(db, teamId, closer.name),
            );
            return g ? { review_grade: g } : { review_grade_unknown: true };
          })()
        : {}),
      // Approximation: entering review was this lane's last update before the close.
      ...(timeInReviewMs !== undefined ? { time_in_review_ms: timeInReviewMs } : {}),
      // ADR 217: the window the wait was graded against, carried so the derivation is auditable
      // from this row alone — without re-reading the ready edge that recorded the promise.
      ...(routing.promised_ms !== undefined ? { promised_wait_ms: routing.promised_ms } : {}),
    },
  });
  // ADR 109: a branch-carrying lane landed — record the seat→SHA→authorizer join. The detail is
  // *attested* (ADR 101 hygiene: only the three known keys are copied off the client body, and only
  // when the client sent them); the actor is server-derived from the authed seat. `authorized_by`
  // here is client-attested (unlike decide/grant — ADR 127 — where the daemon knows the admin).
  // ADR 169: when the close carries no fresh attestation, the stage-one capture (lane.merged,
  // persisted at awaiting_acceptance) flows through — with attested_by crediting the worker when a
  // counterpart performs the closing act.
  if (lane.branch && lane.state === 'done') {
    const m = mergedFromPatch ?? lane.merged ?? undefined;
    appendAudit(db, teamId, {
      actor: closer.name,
      action: 'git.pr_merged',
      target: lane.branch,
      result: 'allow',
      detail: {
        lane: lane.id,
        ...(m?.pr !== undefined ? { pr: m.pr } : {}),
        ...(m?.sha !== undefined ? { sha: m.sha } : {}),
        ...(m?.authorized_by !== undefined ? { authorized_by: m.authorized_by } : {}),
        ...(verified && mergedFromPatch === undefined && lane.merged && ownerAtClose
          ? { attested_by: ownerAtClose }
          : {}),
      },
    });
  }
}
