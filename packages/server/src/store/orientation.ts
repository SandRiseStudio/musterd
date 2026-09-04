import { compareGoals, isAwaitingAcceptance, type Lane, type NextBrief } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { handoffNamedLaneOutOfPlay, handoffNamesNoLane } from './delivery.js';
import { listGoals, nextGoal } from './goals.js';
import { incidentPolicy, openIncidents } from './incidents.js';
import { acceptanceEnteredAt, listLanes, readyForReviewHadNoCandidate } from './lanes.js';
import { getMemberByRole } from './members.js';
import { annotateClose, closeVerdicts } from './review.js';
import { openSeedsForBrief } from './seeds.js';

/**
 * The orientation brief (ADR 049), computed server-side so CLI + MCP render one projection (ADR 084 —
 * never duplicate the derivation per surface). This is the **derived floor**: it reads the daemon's
 * own lane/act state and works at zero agent compliance — no handoff ritual required. The latest
 * `handoff` act only *enriches* the brief with the human-authored *why*; `next_goal` (the ADR 048
 * Goal-source seam, resolved by ADR 084 — see `./goals.js`) enriches it further when a team opts into
 * declared Goals. Neither is required for the floor to work.
 */

/**
 * Owned + live = what you're carrying right now.
 *
 * `awaiting_acceptance` is carried, which `NextBriefSchema` has always documented and this set used
 * to contradict. A lane waiting on an acceptance is in no other bucket either — `up_next` takes only
 * `open` — so leaving it out made it invisible to the one seat still answerable for it, and nothing
 * else times it out (lane `01KZ7D582V`). Submitting is not putting it down.
 */
const LIVE: ReadonlySet<string> = new Set(['claimed', 'active', 'blocked', 'awaiting_acceptance']);

/**
 * How far back to look for a handoff that still describes live work. Bounded on purpose: a team
 * whose last 20 handoffs all closed has no live why, and saying so beats scanning its whole history
 * to prove it.
 */
const WHY_SCAN_DEPTH = 20;

/**
 * How long a handoff that names NO resolvable lane may hold the `why` slot (ADR 264).
 *
 * The #745 predicate retires a handoff when the lane it names leaves play. A handoff that names no
 * lane has nothing to check, so it was served forever — and "forever" is not a corner case here.
 * Measured against the real ledger 2026-08-13: 21 of 22 seats had a bare handoff in the slot, 19 of
 * them the SAME 38-day-old completion notice ("ADR 100 landed — PR #133 … lane resolved") addressed
 * to one seat and broadcast to the team, then served to nearly everyone as their standing why.
 *
 * So the bound is set from evidence, not taste: across the 24 handoffs whose named lane resolved,
 * the subject work closed in a median 0.9d, p95 6.6d, max 12.8d. Fourteen days sits above the whole
 * observed distribution — it can retire nothing that has ever still been live, while retiring every
 * stale line in the ledger today.
 *
 * Age is the LAST resort and the narrowest one: it applies only where no recorded fact exists. A
 * handoff naming a live lane keeps its slot however old (that lane is the fact). And this is the
 * `why` slot alone — wake candidacy keeps ADR 173 abstain-by-showing untouched, because the trade
 * differs: a spurious wake costs money and a dropped one costs work, but a dead instruction in the
 * brief is not abstention, it is misdirection, and it is read every session by every seat.
 */
export const WHY_BARE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function parseMeta(meta: string | null): Record<string, unknown> {
  if (meta === null) return {};
  try {
    const parsed: unknown = JSON.parse(meta);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A malformed meta is not a reason to lose the human's words.
    return {};
  }
}

interface OwedRow {
  ask_id: string;
  ts: number;
  from_name: string;
  lane_id: string;
}

interface HandoffRow {
  from_name: string;
  body: string;
  meta: string | null;
  ts: number;
}

export function deriveNext(
  db: Database,
  teamId: string,
  teamSlug: string,
  member: string,
  shippedLimit = 3,
  upNextLimit = 5,
  opts: { now?: number; upNextSeedLimit?: number } = {},
): NextBrief {
  const now = opts.now ?? Date.now();
  const all = listLanes(db, teamId, teamSlug);
  const mine = all.filter((l) => l.owner_seat === member);

  const in_flight = mine.filter((l) => LIVE.has(l.state));
  // ADR 169/192: annotate what just landed with the DERIVED verified-ness of its close, exactly as
  // the `/lanes` endpoint already does (http.ts) — which is why the web board has rendered
  // accepted/unconfirmed chips since ADR 169 while this brief said only `✓`.
  //
  // That asymmetry is the defect: humans saw the distinction on the board and agents did not see it
  // anywhere, and the brief is the one place a seat reads what just landed. Lane 01M016D5GA — 44
  // files joining typecheck, every CI-deciding gate among them — was swept unreviewed at 24h and
  // listed here indistinguishable from a peer-accepted lane.
  //
  // Absent stays absent: a close that recorded no verdict (pre-ADR-169) is left un-annotated rather
  // than defaulted to `false`. "We do not know" and "nobody confirmed it" are different claims.
  //
  // ADR 283 adds the other half of that sentence — WHY an unaccepted close was unaccepted. The two
  // readings of `unconfirmed` send a seat in opposite directions: `review_timeout` means go chase
  // the person who was asked, `no_candidate` means nobody was ever asked and the roster is the
  // thing to look at. Same audit row, same abstain-by-absence rule, one more field.
  const verdicts = closeVerdicts(db, teamId);
  const shipped = mine
    .filter((l) => l.state === 'done')
    .sort((a, b) => (b.resolved_at ?? b.updated_at) - (a.resolved_at ?? a.updated_at))
    .slice(0, shippedLimit)
    .map((l) => annotateClose(l, verdicts.get(l.id)));
  const up_next: Lane[] = all
    .filter((l) => l.state === 'open')
    .sort((a, b) => a.created_at - b.created_at)
    // goals-front-door design: goal-attached lanes served first (stable within each group).
    .sort((a, b) => Number(b.goal_id !== null) - Number(a.goal_id !== null))
    .slice(0, upNextLimit);

  // ADR 373 increment 4: recorded intentions nobody started, above the open lanes. Fewer than the
  // lanes on purpose — the tray held 31 open Seeds the day this shipped, and a brief that leads with
  // 31 of anything is a brief nobody reads to the end. The total rides along so the window does not
  // read as the whole tray.
  const { seeds: up_next_seeds, total: up_next_seeds_total } = openSeedsForBrief(
    db,
    teamId,
    opts.upNextSeedLimit ?? 3,
  );

  // Owed reviews (ADR 233): lanes still in the acceptance stage whose review ask came to ME.
  //
  // Why the brief and not the inbox: the inbox already carries the ask, and it is not enough. Half
  // the unverified self-closes on this team had the named reviewer ONLINE for ~40 minutes across an
  // 18-hour window and still never answering — more awake time than the reviewers who did answer.
  // The ask arrives once, while the seat is mid-lane, and nothing ever re-surfaces it.
  //
  // "Still in the acceptance stage" IS the unanswered test (ADR 192 as repaired: an accept closes
  // the lane it accepts). So there is no accept-message bookkeeping to drift out of sync with the
  // lane — the lane state is the single source, and a review answered any way at all disappears
  // from here for free.
  const owed_reviews = db
    .prepare<[string, string], OwedRow>(
      `SELECT m.id AS ask_id, m.ts AS ts, mf.name AS from_name,
              json_extract(m.meta, '$.lane_review.lane') AS lane_id
         FROM messages m
         JOIN members mf ON mf.id = m.from_member
         JOIN members mt ON mt.id = m.to_member
        WHERE m.team_id = ?
          AND m.act = 'ask'
          AND mt.name = ?
          AND lane_id IS NOT NULL
        ORDER BY m.ts ASC, m.id ASC`,
    )
    .all(teamId, member)
    .flatMap((r) => {
      const lane = all.find((l) => l.id === r.lane_id);
      // Gone, closed, or mine. Never ask a seat to review its own lane: the ask can name you (a
      // self-submitted lane on a one-seat team), but reviewing your own work is the thing the
      // counterpart exists to prevent, so it is not a reminder — it is a wrong instruction.
      if (!lane || !isAwaitingAcceptance(lane.state) || lane.owner_seat === member) return [];
      return [{ lane, from: r.from_name, ask_id: r.ask_id, ts: r.ts }];
    });

  // The why: the latest handoff addressed to me or the team (not one I sent). Enrichment, never
  // required — but it is read as a live instruction, so a handoff whose named lane has left the
  // recipient's plate is worse than no handoff at all. Walk back from the newest and take the first
  // that is still in play, using the same #745 predicate the wake path uses (`handoffNamedLaneOutOfPlay`):
  // awaiting_acceptance or terminal. A second, narrower copy here (terminal-only) is how this brief
  // kept serving work that was already submitted.
  //
  // Deliberately NOT a `stale` marker on the payload: that forks `NextBriefSchema` for what the
  // brief can answer on its own. Bare / unparseable / missing-lane handoffs stay shown (ADR 173
  // abstain-by-showing; #745 is equally narrow) — but no longer forever: past WHY_BARE_MAX_AGE_MS a
  // handoff naming no resolvable lane gives up the slot (ADR 264), because that is the only case
  // where nothing else can ever retire it. CLI `musterd next` and MCP `team_next` render this
  // projection — they do not re-derive it (ADR 084).
  const rows = db
    .prepare<[string, string, string, number], HandoffRow>(
      `SELECT mf.name AS from_name, m.body AS body, m.meta AS meta, m.ts AS ts
         FROM messages m
         JOIN members mf ON mf.id = m.from_member
         LEFT JOIN members mt ON mt.id = m.to_member
        WHERE m.team_id = ?
          AND m.act = 'handoff'
          AND (mt.name = ? OR m.to_kind IN ('team','broadcast'))
          AND mf.name != ?
        ORDER BY m.ts DESC, m.id DESC
        LIMIT ?`,
    )
    .all(teamId, member, member, WHY_SCAN_DEPTH);

  // The body is passed as well as the meta: every handoff since ADR 231 (#662) names its lane in
  // meta, but the 24 that predate it never will, and a bare row is always "in play" — so without
  // this the newest bare handoff holds the `why` slot permanently. See
  // `handoffNamedLaneOutOfPlay` for why resolving an id out of prose is a recorded fact and not a
  // guess, and why it is all-or-nothing across every lane the body names.
  const row = rows.find(
    (r) =>
      !handoffNamedLaneOutOfPlay(db, teamId, r.meta, r.body) &&
      !(now - r.ts > WHY_BARE_MAX_AGE_MS && handoffNamesNoLane(db, teamId, r.meta, r.body)),
  );

  const why = row
    ? {
        from: row.from_name,
        body: row.body,
        ts: row.ts,
        goal_id: (() => {
          const g = parseMeta(row.meta)['goal_id'];
          return typeof g === 'string' ? g : null;
        })(),
      }
    : null;

  // The Goal-source seam (ADR 048/084): general-team declared Goals, if any exist. musterd's own
  // dogfood uses roadmap.data.ts instead, so this is null there — not every team opts into it.
  const allGoals = listGoals(db, teamId, teamSlug);
  const next_goal = nextGoal(allGoals);

  // goals-front-door design: the brief leads with the unshipped Goals — the missions frame the lane
  // pool, not the other way around. Ordering is the shared ADR 257 rule (shelved last, `in-flight`
  // before `planned`, then most recently declared first).
  const goals = allGoals.filter((g) => g.status !== 'shipped').sort(compareGoals);

  // value-layer design: the team's oldest lanes waiting on acceptance — review debt as ambient
  // candidate work for ANY seat (owed_reviews stays the directed slice). Cap 3, oldest first.
  // A seat's own lane is never its candidate review work: ADR 192 grades a same-seat close as
  // unconfirmed (`verified` requires closer ≠ owner), so serving it here invites the one
  // acceptance the model refuses to count.
  const waiting = all
    .filter((l) => isAwaitingAcceptance(l.state) && l.owner_seat !== member)
    .map((l) => ({ lane: l, entered: acceptanceEnteredAt(db, teamId, l) }))
    .sort((a, b) => a.entered - b.entered);
  const review_debt = waiting.slice(0, 3).map(({ lane, entered }) => ({
    id: lane.id,
    title: lane.title,
    owner: lane.owner_seat,
    waited_ms: Math.max(0, now - entered),
    // Whether ANYONE was asked. `pickReviewCounterpart` returns null on a same-model monoculture —
    // ADR 188/253 refuse `same_model` and ungradeable seats on purpose — and the submit records
    // `no_candidate: true` and then says nothing more. The lane sits in this list looking exactly
    // like one whose named reviewer is merely slow, and a seat reading the brief cannot tell the
    // difference. Measured 2026-08-15: three of five waiting lanes had never been routed to anyone,
    // all three on an all-claude roster. Reporting it does not change the routing doctrine — it
    // stops the silence from reading as health.
    no_candidate: readyForReviewHadNoCandidate(db, teamId, lane.id),
    // Merge-verified submit: an attestation without a SHA means nothing landed — the wait is
    // on the author's merge, not a reviewer. New submits can't reach this state (refused
    // seat-side); this badge covers grandfathered lanes and older clients.
    unlanded: lane.merged?.sha === undefined,
  }));
  // The TOTAL, not the shown count. A cap with no total is a queue that looks as deep as its
  // window: clear the three on offer and the next three appear, with nothing having said they were
  // there. Same 2026-08-15 session — three cleared, two more surfaced.
  const review_debt_total = waiting.length;

  // Incident convergence inc 1 (spec §4): open incidents lead the brief for EVERY member — the
  // banner is how a seat starting a session learns a shared red is already owned work.
  //
  // ADR 271 adds the claim window to it. "UNCLAIMED" alone tells a seat the lane is free but not
  // whether taking it is still their decision: in ten minutes it stops being an invitation and
  // becomes someone's assignment. The countdown is what makes "any seat may claim — context beats
  // role" actionable rather than merely true.
  const incPolicy = incidentPolicy(db, teamId);
  const incidents = openIncidents(db, teamId, teamSlug).map((l) => ({
    lane: l.id,
    gate: l.title.replace(/^incident: /, ''),
    owner_seat: l.owner_seat,
    opened_at: l.created_at,
    // Owned ⇒ no window left to state; disabled ⇒ nothing will ever route it.
    claim_closes_at:
      l.owner_seat || !incPolicy.enabled ? null : l.created_at + incPolicy.claim_window_ms,
    // Null when NOBODY holds the role: this incident will sit unowned, and a seat deciding whether
    // to take it should know that rather than assume the countdown ends with it handled.
    fallback_role:
      l.owner_seat || !incPolicy.enabled
        ? null
        : getMemberByRole(db, teamId, incPolicy.fallback_role)
          ? incPolicy.fallback_role
          : null,
  }));

  return {
    member,
    in_flight,
    shipped,
    up_next,
    up_next_seeds,
    up_next_seeds_total,
    owed_reviews,
    review_debt_total,
    why,
    next_goal,
    goals,
    ...(review_debt.length ? { review_debt } : {}),
    incidents,
  };
}
