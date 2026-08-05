import { isAwaitingAcceptance, type Lane, type NextBrief } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
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

/** A handoff pointing at one of these is describing finished work — see `why` below. */
const TERMINAL: ReadonlySet<string> = new Set(['done', 'abandoned']);

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

/** The lane a handoff carries (`meta.lane_handoff.lane`), or null when it names none. */
function laneOf(meta: Record<string, unknown>): string | null {
  const h = meta['lane_handoff'];
  if (typeof h !== 'object' || h === null) return null;
  const lane = (h as Record<string, unknown>)['lane'];
  return typeof lane === 'string' ? lane : null;
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
  // required — but it is read as a live instruction, so a handoff whose lane has since closed is
  // worse than no handoff at all. This brief served a four-day-old "finish step 7" for a lane whose
  // PR had merged, and the seat reading it went looking for work that did not exist. So walk back
  // from the newest and take the first that still describes something unfinished.
  //
  // Deliberately NOT a `stale` marker on the payload: that forks `NextBriefSchema` for what the
  // brief can answer on its own. And deliberately not a SQL join — a handoff's lane lives in
  // `meta.lane_handoff.lane`, so filtering here keeps the JSON shape in one place.
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

  const byId = new Map(all.map((l) => [l.id, l]));
  const row = rows.find((r) => {
    const meta = parseMeta(r.meta);
    const laneId = laneOf(meta);
    // Abstains by SHOWING, never by hiding (ADR 173): a handoff naming no lane, or naming one this
    // team cannot resolve, is unjudgeable — and an unjudgeable why is still the human's words.
    if (laneId === null) return true;
    const lane = byId.get(laneId);
    return lane === undefined || !TERMINAL.has(lane.state);
  });

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
  const next_goal = nextGoal(listGoals(db, teamId, teamSlug));

  return { member, in_flight, shipped, up_next, owed_reviews, why, next_goal };
}
