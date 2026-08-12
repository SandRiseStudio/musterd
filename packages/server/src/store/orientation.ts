import { isAwaitingAcceptance, type Goal, type Lane, type NextBrief } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { handoffNamedLaneOutOfPlay } from './delivery.js';
import { listGoals, nextGoal } from './goals.js';
import { listLanes } from './lanes.js';

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
): NextBrief {
  const all = listLanes(db, teamId, teamSlug);
  const mine = all.filter((l) => l.owner_seat === member);

  const in_flight = mine.filter((l) => LIVE.has(l.state));
  const shipped = mine
    .filter((l) => l.state === 'done')
    .sort((a, b) => (b.resolved_at ?? b.updated_at) - (a.resolved_at ?? a.updated_at))
    .slice(0, shippedLimit);
  const up_next: Lane[] = all
    .filter((l) => l.state === 'open')
    .sort((a, b) => a.created_at - b.created_at)
    // goals-front-door design: goal-attached lanes served first (stable within each group).
    .sort((a, b) => Number(b.goal_id !== null) - Number(a.goal_id !== null))
    .slice(0, upNextLimit);

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
  // abstain-by-showing; #745 is equally narrow). CLI `musterd next` and MCP `team_next` render this
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
  const row = rows.find((r) => !handoffNamedLaneOutOfPlay(db, teamId, r.meta, r.body));

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

  // goals-front-door design: the brief leads with the unshipped Goals, wave-ordered, `in-flight`
  // before `planned` at equal wave — the missions frame the lane pool, not the other way around.
  const waveRank = (w: Goal['wave']) =>
    w === null || w === 'later' ? Number.POSITIVE_INFINITY : w;
  const goals = allGoals
    .filter((g) => g.status !== 'shipped')
    .sort(
      (a, b) =>
        waveRank(a.wave) - waveRank(b.wave) ||
        Number(a.status === 'planned') - Number(b.status === 'planned'),
    );

  return { member, in_flight, shipped, up_next, owed_reviews, why, next_goal, goals };
}
