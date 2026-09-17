import {
  ACCEPTANCE_MOVES_NOTICE,
  type AskTier,
  type Lane,
  askContract,
  makeEnvelope,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { appendLaneEventRequired, laneOwnerHistory } from '../store/audit.js';
import { getLane, listLanes } from '../store/lanes.js';
import { getMemberByName } from '../store/members.js';
import {
  type HeldAcceptance,
  abandonedAcceptances,
  heldAcceptances,
  openAcceptanceAsk,
  selectReviewCounterpart,
} from '../store/review.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { getTeamBySlug } from '../store/teams.js';
import { routeEnvelope } from './route.js';

/**
 * What the sweep needs of a team: its id and its slug, nothing else. Narrower than the full roster
 * row on purpose — the reaper's `listActiveTeams` hands out exactly this pair.
 */
type TeamRef = { id: string; slug: string };

/**
 * Re-routing an acceptance away from a reviewer who is no longer there.
 *
 * Two triggers, one implementation. ADR 412 handles the explicit goodbye — a seat posting
 * `/residency/session {event:'end'}` hands back everything it holds. Lane
 * 01M2RQ8W0RR838P2KW3SP6SYGV handles the silent one — a reaped seat says nothing at all, so the
 * reaper notices on its behalf. What differs is only how the departure became known, which is why
 * the caller supplies both the seat and the acceptances rather than this module inferring them.
 *
 * The ask-composition and delivery helpers live here rather than in the HTTP transport because
 * the reaper needs them too, and `presence/` must not reach up into `transport/`.
 */

export function acceptanceAskBody(
  title: string,
  opts: {
    human?: boolean;
    peerFindings?: string;
    overlapNotice?: string;
    noGoalNotice?: string;
  } = {},
): string {
  const checklist =
    'Judge the LANDED OUTCOME (not a code review): ' +
    '(1) Intent — matches the lane brief? ' +
    '(2) Principles — project/musterd hard rules? ' +
    '(3) Usable — exercise the path enough to say it works? ' +
    '(4) Feel — only if UI/copy/brand is in surface, else N/A. ' +
    'Accept → move the lane to done; reject → send it back to active with a concrete note.' +
    // Lane 01M2P2E2H6: the acceptor learns what `accept` DOES before they send one, not from the
    // ack afterwards. Appended to the checklist so both the peer and human bodies below carry it.
    ACCEPTANCE_MOVES_NOTICE;
  const overlap = (opts.overlapNotice ?? '') + (opts.noGoalNotice ?? '');
  if (opts.human && opts.peerFindings !== undefined) {
    return (
      `[lane] human acceptance required: "${title}" — peer accepted with: "${opts.peerFindings}". ` +
      checklist +
      overlap
    );
  }
  return `[lane] acceptance requested: "${title}" — ${checklist}${overlap}`;
}

/**
 * The overlap line (ADR 192, lane 01KYX6QY5N). The picker excludes the lane's CURRENT owner and
 * nobody else, so a lane that changed hands can route its acceptance to a previous owner — an
 * author of the very artifact being judged. Rather than exclude them (which would narrow a pool
 * that already finds nobody on most attempts, to close a hole seen on 3 lanes ever), the ask NAMES
 * the overlap and leaves the call to the acceptor: recusal is a judgment, not a computation.
 *
 * Phrased as a fact plus the two honest options, never as an accusation — the acceptor may well be
 * the right judge (ADR 192 acceptance is intent-vs-brief, and a brief's author knows the brief).
 */
export function priorOwnerNotice(reviewer: string, priorOwners: string[]): string {
  return priorOwners.includes(reviewer)
    ? ' NOTE — you previously owned this lane, so you are named on the artifact you are judging. ' +
        'That is allowed and may even make you the best judge of intent, but it is yours to weigh: ' +
        'accept if you can judge it independently, or decline and say "recusing — I authored this" ' +
        'so it routes to someone else.'
    : '';
}

export function noGoalNotice(goalId: string | null): string {
  if (goalId !== null) return '';
  return ' This lane is on no goal — if it advanced one, link it (lane_update {goal_id}) before resolving.';
}

/**
 * Outcome-acceptance ask (ADR 192): a directed `ask` act from the worker to the picked acceptor —
 * unlike {@link deliverLaneAct} this is act `ask`, so it rides the whole ask-stream machinery
 * (tier contract, reachability, ask-span telemetry) with no new act kind. Best-effort like every
 * lane delivery: a failed compose never fails the verb (the degradation path is self-close anyway).
 */
export function deliverLaneAskAct(
  ctx: Ctx,
  team: TeamRow,
  from: MemberRow,
  to: string,
  body: string,
  meta: Record<string, unknown>,
): boolean {
  try {
    const env = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: from.name,
      to: { kind: 'member', name: to },
      act: 'ask',
      body,
      meta,
    });
    routeEnvelope(ctx, team, from, env, undefined, true);
    return true;
  } catch {
    /* advisory only — the lane verb already succeeded. The boolean is for the one caller that
       must NOT treat it as advisory: a hand-named acceptor whose ask failed to mint is the silent
       limbo lane 01M1QYHJFY closed, and the submit handler fails loudly on `false`. */
    return false;
  }
}

export function deliverLaneAskSuperseded(
  ctx: Ctx,
  team: TeamRow,
  from: MemberRow,
  to: string,
  askId: string,
  lane: Lane,
  newAcceptor: string,
): void {
  try {
    const env = makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: from.name,
      to: { kind: 'member', name: to },
      act: 'resolve',
      thread: askId,
      body:
        `[lane] acceptance of "${lane.title}" re-routed to ${newAcceptor} by ${from.name} — ` +
        `the ask you held is closed and nothing is owed on it. A verdict sent on it now binds to nothing.`,
      meta: { lane_review_superseded: { lane: lane.id, ask: askId, reviewer: newAcceptor } },
    });
    routeEnvelope(ctx, team, from, env, undefined, true);
  } catch {
    /* advisory — the re-route itself is recorded in the audit and the new ask is what binds */
  }
}

/** How the daemon came to know the reviewer was gone. Recorded on the audit row. */
export type DepartureRoute = 'departed' | 'reaped';

/**
 * Re-route one seat's held acceptances to freshly picked reviewers.
 *
 * Reuses the hand re-route's machinery exactly (`lane.review_rerouted` + a superseded notice + a
 * fresh ask), because the hard part is already decided there: the old ask goes inert, a late
 * verdict on it cannot move the lane, and the seat that held it is told where the acceptance went.
 * Only the trigger is new, so the audit row records `route` and the gone seat as `actor`.
 *
 * No wake is leased, matching the named path: the ask waits in an inbox, as it does at submit.
 * If the picker finds nobody, nothing is minted and the lane keeps the ask it has — a re-route with
 * no destination would strand the acceptance worse than leaving it for `staleAcceptanceWarning`.
 */
export function rerouteAcceptances(
  ctx: Ctx,
  team: TeamRow,
  gone: MemberRow,
  held: HeldAcceptance[],
  route: DepartureRoute,
): string[] {
  const out: string[] = [];
  for (const one of held) {
    const lane = getLane(ctx.db, team.id, one.lane, team.slug);
    if (!lane) continue;
    const worker = lane.owner_seat ?? gone.name;
    const pick = selectReviewCounterpart(
      ctx.db,
      team.id,
      lane,
      worker,
      ctx.config.presenceTimeoutMs,
      {
        departing: gone.name,
      },
    ).pick;
    if (!pick || pick.reviewer === gone.name) continue;
    const humanRequired = lane.risk.length > 0;
    const acceptanceTier: AskTier = 'standard';
    appendLaneEventRequired(ctx.db, team.id, {
      actor: gone.name,
      action: 'lane.review_rerouted',
      target: lane.id,
      result: 'allow',
      detail: {
        lane: lane.id,
        owner: worker,
        stakes: lane.stakes,
        stakes_provenance: lane.stakes_provenance,
        ...(lane.merged ? { merged: lane.merged } : {}),
        reviewer: pick.reviewer,
        route,
        review_grade: pick.grade,
        from_reviewer: gone.name,
        superseded_ask: one.ask,
        human_required: humanRequired,
        ask_tier: acceptanceTier,
        ask_timeout_ms: askContract(acceptanceTier).timeout_ms,
      },
    });
    deliverLaneAskSuperseded(ctx, team, gone, gone.name, one.ask, lane, pick.reviewer);
    const priorOwners = laneOwnerHistory(ctx.db, team.id, lane.id);
    deliverLaneAskAct(
      ctx,
      team,
      gone,
      pick.reviewer,
      acceptanceAskBody(lane.title, {
        overlapNotice: priorOwnerNotice(pick.reviewer, priorOwners),
        noGoalNotice: noGoalNotice(lane.goal_id),
      }),
      {
        species: 'approve',
        tier: acceptanceTier,
        lane_review: {
          lane: lane.id,
          title: lane.title,
          branch: lane.branch,
          ...(lane.merged ? { merged: lane.merged } : {}),
          route,
          grade: pick.grade,
        },
      },
    );
    out.push(lane.id);
  }
  return out;
}

/** ADR 412's trigger: the seat said goodbye, so it is gone whatever its presence row still says. */
export function rerouteDepartedAcceptances(
  ctx: Ctx,
  team: TeamRow,
  departing: MemberRow,
): string[] {
  return rerouteAcceptances(
    ctx,
    team,
    departing,
    heldAcceptances(ctx.db, team.id, departing.name),
    'departed',
  );
}

/**
 * Lane 01M2RQ8W0RR838P2KW3SP6SYGV — the silent departure, swept from the reaper's tick.
 *
 * A reaped seat emits `presence.detached` with reason 'reaped' and no `residency.session_ended`, so
 * ADR 412's trigger never fires for it. Here the departure has to be inferred, which is what
 * `abandonedAcceptances` does — and it infers it with `hasLivePresence`, the same predicate the
 * picker excludes candidates by, so a seat this sweeps is a seat the picker would not have picked.
 *
 * Deliberately NOT gated behind a `loops.*` policy flag, unlike ADR 229's sweep. That gate guards a
 * DESTRUCTIVE act — closing a lane as `done` with no verdict. This one never closes a lane and never
 * invents a verdict; the worst it can do is move an ask to a seat that is actually there, which is
 * the same operation ADR 412 already performs ungated on the goodbye path.
 *
 * It terminates on its own rather than by a counter: once re-routed, the lane's open ask belongs to
 * a LIVE seat, so the next tick's `abandonedAcceptances` no longer names it. A lane only comes back
 * if its new reviewer also vanishes, which is the case where trying again is the right answer.
 */
export function sweepReapedAcceptances(ctx: Ctx, ref: TeamRef): string[] {
  // `routeEnvelope` needs the full roster row; the reaper only has id+slug, so resolve once here
  // rather than making every caller carry a row it does not have.
  const team = getTeamBySlug(ctx.db, ref.slug);
  if (!team) return [];
  const out: string[] = [];
  const holders = new Set<string>();
  for (const lane of listLanes(ctx.db, team.id, team.slug)) {
    if (lane.state !== 'awaiting_acceptance') continue;
    const open = openAcceptanceAsk(ctx.db, team.id, lane.id);
    if (open) holders.add(open.to);
  }
  for (const name of holders) {
    const gone = getMemberByName(ctx.db, team.id, name);
    if (!gone) continue;
    const stranded = abandonedAcceptances(ctx.db, team.id, name, ctx.config.presenceTimeoutMs);
    if (stranded.length === 0) continue;
    out.push(...rerouteAcceptances(ctx, team, gone, stranded, 'reaped'));
  }
  return out;
}
