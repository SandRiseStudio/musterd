import type { Lane, NextBrief } from '@musterd/protocol';
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

/** Owned + live = what you're carrying right now. */
const LIVE: ReadonlySet<string> = new Set(['claimed', 'active', 'blocked']);

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

  // The why: the latest handoff addressed to me or the team (not one I sent). Enrichment, never required.
  const row = db
    .prepare<[string, string, string], HandoffRow>(
      `SELECT mf.name AS from_name, m.body AS body, m.meta AS meta, m.ts AS ts
         FROM messages m
         JOIN members mf ON mf.id = m.from_member
         LEFT JOIN members mt ON mt.id = m.to_member
        WHERE m.team_id = ?
          AND m.act = 'handoff'
          AND (mt.name = ? OR m.to_kind IN ('team','broadcast'))
          AND mf.name != ?
        ORDER BY m.ts DESC, m.id DESC
        LIMIT 1`,
    )
    .get(teamId, member, member);

  const why = row
    ? {
        from: row.from_name,
        body: row.body,
        ts: row.ts,
        goal_id:
          row.meta &&
          typeof (JSON.parse(row.meta) as Record<string, unknown>)['goal_id'] === 'string'
            ? ((JSON.parse(row.meta) as Record<string, string>)['goal_id'] as string)
            : null,
      }
    : null;

  // The Goal-source seam (ADR 048/084): general-team declared Goals, if any exist. musterd's own
  // dogfood uses roadmap.data.ts instead, so this is null there — not every team opts into it.
  const next_goal = nextGoal(listGoals(db, teamId, teamSlug));

  return { member, in_flight, shipped, up_next, why, next_goal };
}
