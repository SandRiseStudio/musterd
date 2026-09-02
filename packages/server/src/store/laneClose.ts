import { type Lane, isAwaitingAcceptance, reviewGrade } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { appendAudit, appendLaneEventRequired, peerReviewGradeOf, reviewRouting } from './audit.js';
import { memberIsHuman, memberModelByName, workerFamily } from './review.js';

/**
 * The closing seat, as much of it as the audit needs.
 *
 * `kind` carries a third value beyond the member kinds: `'system'`, the daemon closing a lane no
 * seat was left to close (ADR 229). It is not cosmetic — see `verified` below.
 */
export interface Closer {
  name: string;
  kind: string;
}

/** ADR 229: the daemon itself, which is not a counterpart and can never confirm anything. */
const SYSTEM_KIND = 'system';

/** A merge attestation supplied by the closing patch itself (ADR 109), if any. */
export interface MergedAttestation {
  pr?: number | undefined;
  sha?: string | undefined;
  authorized_by?: string | undefined;
}

/**
 * What the close RECORDED, handed back to the caller (ADR 283).
 *
 * Both fields are already derived here and written to `lane.closed`; returning them costs nothing
 * and buys the one thing a caller cannot otherwise have honestly. The MCP resolve hint told an
 * `acceptance_exempt` close it was an "unconfirmed close" and to "prefer lane_submit" — advice
 * `lane_submit` had contradicted moments earlier, because the adapter branched on ownership with no
 * way to see the reason. `verified: false` alone cannot answer it: the by-design exemption and the
 * ADR 172 degradation both land there, which is the conflation ADR 283 exists to end.
 */
export interface LaneCloseVerdict {
  /** ADR 169: a seat other than the owner-at-close confirmed it. */
  verified: boolean;
  /** The recorded `lane.closed` reason — the ladder's verdict, not a re-derivation. */
  reason: string;
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
): LaneCloseVerdict {
  // ADR 169: every terminal edge writes lane.closed, and verified-ness is DERIVED here — never
  // stored on the lane. Verified ⟺ done + the closer is a different seat than the owner at close
  // time (pinned in this row so post-close handoffs can't flip the verdict). reason distinguishes
  // the counterpart confirm from the two honest self-close shapes.
  const ownerAtClose = before.owner_seat;
  // ADR 229: the system is excluded EXPLICITLY, and this is the whole reason `kind: 'system'` exists.
  // "A seat other than the owner closed it" is satisfied trivially by a daemon sweep, so without
  // this clause every swept lane would record `verified: true` and a `counterpart_confirm` reason —
  // a cross-seat review that never happened, fed straight into the ADR 056 diversity conclusions,
  // which read this exact field. The failure would be silent and would corrupt research data rather
  // than break anything visible. Pinned by `laneSweep.test.ts`.
  const systemClosed = closer.kind === SYSTEM_KIND;
  const verified =
    !systemClosed && lane.state === 'done' && ownerAtClose !== null && closer.name !== ownerAtClose;
  // ADR 169/172: what the ready edge recorded — routed-or-not, and whether the lane's risk made a
  // human review REQUIRED. Read once; feeds both the reason and the missed flag.
  const routing = isAwaitingAcceptance(before.state)
    ? reviewRouting(db, teamId, lane.id)
    : {
        routed: undefined as boolean | undefined,
        human_required: undefined as boolean | undefined,
        promised_ms: undefined as number | undefined,
        exempt: undefined as boolean | undefined,
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
  // Which ask the submit actually sent — orthogonal to WHO closed the lane, and the fact
  // `review_swept` alone could never carry (lane 01M042GWK3).
  //
  // The rungs are the seat-closed ladder's own, extracted so the two paths cannot drift again.
  // Drift is precisely what happened: the ladder below distinguishes "nobody was asked" from
  // "asked and unanswered" with an ADR behind each rung, and `systemClosed` short-circuited ahead
  // of all of it — so the ONE close path with no human watching recorded the least. Lane
  // 01M016D5GA (44 files joining typecheck) was swept at 24h reading exactly like a lane whose
  // reviewer had been asked and ignored it, when in truth no ask had ever been sent.
  //
  // `undefined` abstains, and that is load-bearing: a lane whose ready row predates these fields
  // gets no verdict invented about it, the same discipline every rung here already follows.
  const askOutcome:
    | 'acceptance_exempt'
    | 'human_review_missed'
    | 'no_candidate'
    | 'routed'
    | undefined =
    routing.exempt === true
      ? 'acceptance_exempt'
      : routing.routed === false
        ? routing.human_required === true
          ? 'human_review_missed'
          : 'no_candidate'
        : routing.routed === true
          ? 'routed'
          : undefined;
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
  // ADR 283: the close reason, derived here and RETURNED so a caller can report the label the
  // ledger actually recorded. Hoisted out of the audit detail for that reason alone — the ladder
  // below is unchanged. A caller that re-derived this from `lane.stakes` would be reading an
  // editable field (ADR 234) instead of the recorded fact, which is exactly the shortcut the
  // `acceptance_exempt` rung warns against.
  const reason =
    lane.state === 'abandoned'
      ? 'abandoned'
      : // ADR 229: its own reason, ahead of every seat-authored one. Reusing `review_timeout`
        // would undo the ADR 217 increment that separated "the owner gave up early" from
        // "nobody ever answered" — a swept lane is a third, categorically different edge:
        // nobody was even present to give up. The ledger has to be able to answer "did a seat
        // decide this, or did the clock?".
        systemClosed
        ? 'review_swept'
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
              askOutcome === 'acceptance_exempt'
              ? // ADR 234 increment 2: nobody was asked BY DESIGN, on the lane's own declared
                // stakes. Ahead of `no_candidate` because both present as `routed: false` and
                // only this one is a choice — `no_candidate` is the sanctioned degradation
                // where the system wanted a counterpart and could not find one. Folding them
                // would inflate the degradation count with lanes that degraded nothing, and
                // that count is a live input to dolly's bucket split and to this ADR's own 84%.
                //
                // Keyed on the RECORDED `acceptance_exempt` from the ready row, never on
                // `lane.stakes` here: stakes are editable after open (ADR 234), so re-deriving
                // at close would let an edit made after the submit rewrite what the submit did.
                // The whole point of the ladder's discipline is that only a recorded fact earns
                // a label, and this is the case where the tempting shortcut is a live field.
                'acceptance_exempt'
              : askOutcome === 'human_review_missed' || askOutcome === 'no_candidate'
                ? // Same discipline one level down: only a RECORDED requirement earns the
                  // `human_review_missed` label. A row that abstains keeps the older, weaker
                  // `no_candidate` — the label it would have carried before the requirement was
                  // ever recorded — rather than a verdict about a past that never wrote one down.
                  askOutcome
                : // ADR 217: an ask WAS sent and the owner closed it themselves — but "timeout" was
                  // asserting an elapsed wait nobody had measured. 11 of the first 18 such closes
                  // happened inside five minutes, the fastest after 8 seconds, while the median
                  // successful confirm took 22 minutes. The reason now says which of the two
                  // opposite failures this was, and abstains when the promise is unknowable.
                  waitVerdict
            : 'self_close';
  // The close is a lane transition, so it is the replicated, required form (lane-replication spec
  // §Hole 3): if the record cannot be written, the close does not happen.
  appendLaneEventRequired(db, teamId, {
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
      reason,
      // Only on the swept path. Everywhere else `reason` already answers it — the seat-closed
      // ladder IS this verdict, except in the `routed` case where the reason is the ADR 217 wait
      // verdict and "an ask was sent" is implied by it. Emitting it twice would put the same fact
      // in two fields and invite them to disagree.
      ...(systemClosed && askOutcome !== undefined ? { ask_outcome: askOutcome } : {}),
      // ADR 172: flagged even on a verified close — an agent counterpart's confirm on a risky lane
      // is a real review, but not the human one the risk tag demanded.
      ...(humanReviewMissed ? { human_review_missed: true } : {}),
      // ADR 173 clause 4: an abstention has to be COUNTABLE, or the counter-metric's silence is
      // indistinguishable from a clean zero. Recorded only where the question was live — a lane
      // that entered review, whose ready row could not tell us what it required.
      ...(isAwaitingAcceptance(before.state) && routing.human_required === undefined
        ? { human_required_unknown: true }
        : {}),
      // ADR 202 gave acceptance a confirmed door: the acceptor answers from their own seat and
      // `verified` falls out of `closer !== owner-at-close`. This is the other door — a human's
      // verdict given in-session, spoken to the agent and relayed as `{authorized_by}`. It is NOT
      // promoted: the name is client-attested (see the ADR 109 note below), so trusting it would
      // let any seat mint its own acceptance — precisely the failure ADR 192 exists to prevent.
      //
      // But it must not vanish either, and it did. `authorized_by` reached the ledger only through
      // `git.pr_merged`, which a branchless lane never writes — so on a lane closed with no branch
      // the claimed authorizer was accepted by the API, stored on the lane row, and recorded in the
      // audit NOWHERE. Observed on lane 01KXY9YRQWG6 (2026-08-12): nick's acceptance, relayed by
      // izzo, left no trace in the artifact ADR 109 and ADR 127 exist to make joinable.
      //
      // Recorded only on an UNVERIFIED close: when a counterpart genuinely confirmed, the closer is
      // the authority and a second client-attested one alongside `verified: true` would blur which
      // fact carried the confirmation. Keyed separately from `verified` on purpose — ADR 173: this
      // is a countable third shape, a self-close that names an authorizer, which is not the same
      // event as a self-close that names nobody. Folding them would leave ADR 169's review-catch
      // rate unable to tell "nobody accepted" from "a human did, through a seat".
      ...(!verified && mergedFromPatch?.authorized_by !== undefined
        ? { authorization_claimed: mergedFromPatch.authorized_by }
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
  return { verified, reason };
}
