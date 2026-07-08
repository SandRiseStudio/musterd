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

interface GoalSignalRow {
  from_name: string;
  act: string;
  meta: string;
  ts: number;
}

type Wave = Goal['wave'];

/** One wave-setting signal — a Goal declaration or a `defer` — carrying the wave it asserts and when. */
interface WaveEvent {
  ts: number;
  wave: Wave;
}

/** The declared skeleton for one Goal, plus the epoch/wave-fold inputs gathered across the log. */
interface GoalAccumulator {
  id: string;
  title: string;
  depends_on: string[];
  declared_by: string;
  declared_at: number;
  /** Every wave assertion (declaration base wave + each `defer`), newest-ts wins for the effective wave. */
  waveEvents: WaveEvent[];
  /** Direction-changing acts naming this Goal: `defer`s + goal-scoped `steer`s. Its length is the epoch. */
  epoch: number;
}

/**
 * Ascending timestamps of every **plan-epoch bump** per Goal id — one per `defer`, and per `steer`
 * that names a Goal via `meta.goal_id`. The count is the Goal's epoch; the staleness layer (ADR 109
 * §5) counts how many landed after a lane was claimed to tell a fresh lane from one building against a
 * superseded plan. Same derivation rule as {@link listGoals}'s epoch, so the two never disagree.
 */
export function goalEpochBumps(db: Database, teamId: string): Map<string, number[]> {
  const rows = db
    .prepare<[string], { meta: string; ts: number }>(
      `SELECT meta, ts FROM messages
        WHERE team_id = ? AND act IN ('defer','steer') AND meta IS NOT NULL
        ORDER BY ts ASC, id ASC`,
    )
    .all(teamId);
  const bumps = new Map<string, number[]>();
  for (const r of rows) {
    let meta: unknown;
    try {
      meta = JSON.parse(r.meta);
    } catch {
      continue;
    }
    const gid = signalGoalId(meta);
    if (gid === null) continue;
    const arr = bumps.get(gid);
    if (arr) arr.push(r.ts);
    else bumps.set(gid, [r.ts]);
  }
  return bumps;
}

/** The goal id a `defer`/`steer` names (`meta.goal_id`), or null if it names none. */
function signalGoalId(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const id = (meta as { goal_id?: unknown }).goal_id;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

/** The wave a `defer` asserts: `meta.wave` when a number, else `'later'` (absent/"later" both defer). */
function deferWave(meta: unknown): Wave {
  const w = (meta as { wave?: unknown } | null | undefined)?.wave;
  return typeof w === 'number' && Number.isInteger(w) ? w : 'later';
}

/**
 * Every declared Goal for the team, status + **plan epoch** attached (both derived, never stored).
 *
 * The declared skeleton is the latest `message`-to-`@team` carrying `meta.goal` per id (ADR 048/084).
 * On top of it, increment 3 (ADR 109) folds the direction-changing acts read out of the same log:
 *   - a **`defer`** naming the Goal asserts a new `wave` (the plan mutation ADR 103 stubbed) — latest
 *     wave-setting signal by `ts` wins, so a `defer` re-sequences `nextGoal` exactly as a re-declaration
 *     would, with no stored column and no write-path mutation;
 *   - each **`defer`** and each goal-scoped **`steer`** (one that names `meta.goal_id`) bumps the epoch.
 * This is the same read-side-projection posture as steer supersession and derived Goal status.
 */
export function listGoals(db: Database, teamId: string, teamSlug: string): Goal[] {
  // Declarations (message→team+meta.goal) and the two direction-changing acts, in one ts-ordered scan.
  const rows = db
    .prepare<[string], GoalSignalRow>(
      `SELECT mf.name AS from_name, m.act AS act, m.meta AS meta, m.ts AS ts
         FROM messages m
         JOIN members mf ON mf.id = m.from_member
        WHERE m.team_id = ? AND m.meta IS NOT NULL
          AND ((m.act = 'message' AND m.to_kind = 'team') OR m.act IN ('defer','steer'))
        ORDER BY m.ts ASC, m.id ASC`,
    )
    .all(teamId);

  const byId = new Map<string, GoalAccumulator>();
  // Deferred/steered signals whose target Goal we may not have declared yet — replayed after the scan
  // so signal-before-declaration ordering can't drop an epoch bump or a wave override.
  const pending: { act: string; meta: unknown; ts: number }[] = [];

  const applySignal = (act: string, meta: unknown, ts: number): boolean => {
    const goalId = signalGoalId(meta);
    if (goalId === null) return true; // a goal-less steer — no Goal to move; nothing pending.
    const acc = byId.get(goalId);
    if (!acc) return false; // target not (yet) declared — replay after all declarations are in.
    acc.epoch += 1;
    if (act === 'defer') acc.waveEvents.push({ ts, wave: deferWave(meta) });
    return true;
  };

  for (const row of rows) {
    if (row.act === 'defer' || row.act === 'steer') {
      let meta: unknown;
      try {
        meta = JSON.parse(row.meta);
      } catch {
        continue;
      }
      if (!applySignal(row.act, meta, row.ts)) pending.push({ act: row.act, meta, ts: row.ts });
      continue;
    }
    // A Goal declaration (latest per id wins for the skeleton; its base wave is a wave event).
    let parsed: GoalDeclareMeta;
    try {
      parsed = GoalDeclareMetaSchema.parse(JSON.parse(row.meta));
    } catch {
      continue; // not a Goal declaration — an ordinary message with unrelated meta.
    }
    const g = parsed.goal;
    const prior = byId.get(g.id);
    byId.set(g.id, {
      id: g.id,
      title: g.title,
      depends_on: g.depends_on ?? [],
      declared_by: row.from_name,
      declared_at: row.ts,
      // A re-declaration replaces the skeleton wholesale but never erases accrued epoch/defer history.
      waveEvents: [...(prior?.waveEvents ?? []), { ts: row.ts, wave: g.wave ?? null }],
      epoch: prior?.epoch ?? 0,
    });
  }
  // Replay signals that arrived before their Goal's declaration (rare, but order-independent now).
  for (const p of pending) applySignal(p.act, p.meta, p.ts);

  // Derive status from lanes joined by goal_id — one lane scan, grouped in memory (not one per Goal).
  const lanesByGoal = new Map<string, Lane[]>();
  for (const lane of listLanes(db, teamId, teamSlug)) {
    if (lane.goal_id === null) continue;
    const group = lanesByGoal.get(lane.goal_id);
    if (group) group.push(lane);
    else lanesByGoal.set(lane.goal_id, [lane]);
  }

  return [...byId.values()].map((g) => ({
    id: g.id,
    title: g.title,
    // Effective wave = the newest wave assertion (declaration or defer) by ts; ties keep the later push.
    wave: g.waveEvents.reduce((best, e) => (e.ts >= best.ts ? e : best)).wave,
    depends_on: g.depends_on,
    declared_by: g.declared_by,
    declared_at: g.declared_at,
    status: deriveGoalStatus(lanesByGoal.get(g.id) ?? []),
    epoch: g.epoch,
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
