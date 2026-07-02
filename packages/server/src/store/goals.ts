import type { Goal, GoalDeclareMeta, Lane } from '@musterd/protocol';
import { GoalDeclareMetaSchema } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { deriveGoalStatus, listLanes } from './lanes.js';

/**
 * Declared Goals for a general team (ADR 048's seam, resolved by ADR 084): a Goal is an ordinary
 * `message` act to `@team` whose `meta.goal` carries the skeleton — no new act, no new table.
 * musterd's own dogfood keeps `roadmap.data.ts` as its Goal store; this is what any other team gets.
 * Re-declaring the same `id` amends it (latest wins) — the same "curated is a feature" posture as the
 * dogfood store, just PR-less.
 */

interface GoalMessageRow {
  from_name: string;
  meta: string;
  ts: number;
}

/** Every declared Goal for the team, latest declaration per id wins, status attached (never stored). */
export function listGoals(db: Database, teamId: string, teamSlug: string): Goal[] {
  const rows = db
    .prepare<[string], GoalMessageRow>(
      `SELECT mf.name AS from_name, m.meta AS meta, m.ts AS ts
         FROM messages m
         JOIN members mf ON mf.id = m.from_member
        WHERE m.team_id = ? AND m.act = 'message' AND m.to_kind = 'team' AND m.meta IS NOT NULL
        ORDER BY m.ts ASC, m.id ASC`,
    )
    .all(teamId);

  const byId = new Map<string, Omit<Goal, 'status'>>();
  for (const row of rows) {
    let parsed: GoalDeclareMeta;
    try {
      parsed = GoalDeclareMetaSchema.parse(JSON.parse(row.meta));
    } catch {
      continue; // not a Goal declaration — an ordinary message with unrelated meta.
    }
    const g = parsed.goal;
    byId.set(g.id, {
      id: g.id,
      title: g.title,
      wave: g.wave ?? null,
      depends_on: g.depends_on ?? [],
      declared_by: row.from_name,
      declared_at: row.ts,
    });
  }

  // Derive status from lanes joined by goal_id — one lane scan, grouped in memory (not one per Goal).
  const lanesByGoal = new Map<string, Lane[]>();
  for (const lane of listLanes(db, teamId, teamSlug)) {
    if (lane.goal_id === null) continue;
    const group = lanesByGoal.get(lane.goal_id);
    if (group) group.push(lane);
    else lanesByGoal.set(lane.goal_id, [lane]);
  }

  return [...byId.values()].map((g) => ({
    ...g,
    status: deriveGoalStatus(lanesByGoal.get(g.id) ?? []),
  }));
}

/** Rank a Goal's wave for sorting — `'later'` and undeclared both sort last, mirroring roadmap.data.ts. */
function waveRank(wave: Goal['wave']): number {
  return wave === null || wave === 'later' ? Number.POSITIVE_INFINITY : wave;
}

/**
 * The next Goal to pick up (ADR 049/084): the first `planned` Goal by `wave`, skipping any still
 * blocked by an unshipped `depends_on`. Pure — takes the already-derived list from {@link listGoals}.
 */
export function nextGoal(goals: Goal[]): Goal | null {
  const shipped = new Set(goals.filter((g) => g.status === 'shipped').map((g) => g.id));
  const candidates = goals
    .filter((g) => g.status === 'planned')
    .filter((g) => g.depends_on.every((d) => shipped.has(d)))
    .sort((a, b) => waveRank(a.wave) - waveRank(b.wave));
  return candidates[0] ?? null;
}
