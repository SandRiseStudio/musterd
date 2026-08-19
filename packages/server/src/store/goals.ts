import type { Goal, GoalDeclareMeta, Lane } from '@musterd/protocol';
import {
  compareGoals,
  GoalDeclareMetaSchema,
  GoalOutcomeMetaSchema,
  GoalRetractMetaSchema,
} from '@musterd/protocol';
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
  story?: string;
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
 * that names a Goal via `meta.goal_id`. The count is the Goal's epoch; the staleness layer (ADR 111
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

/** ADR 257: a pre-257 declaration's integer wave is readable but inert — it orders nothing. */
function normalizeDeclaredWave(wave: number | 'later' | undefined): Wave {
  return wave === 'later' ? 'later' : null;
}

/**
 * Every declared Goal for the team, status + **plan epoch** attached (both derived, never stored).
 *
 * The declared skeleton is the latest `message`-to-`@team` carrying `meta.goal` per id (ADR 048/084).
 * On top of it, increment 3 (ADR 111) folds the direction-changing acts read out of the same log:
 *   - a **`defer`** naming the Goal **shelves** it (the plan mutation ADR 103 stubbed; ADR 257 made
 *     shelving its whole meaning) — latest wave-setting signal by `ts` wins, so a re-declaration
 *     un-shelves, with no stored column and no write-path mutation;
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
  // Outcome notes (value-layer design) live BESIDE the skeleton accumulator, never inside it — a
  // re-declaration replaces the skeleton wholesale, and an outcome must survive that. Latest-by-ts
  // wins (the scan is ts-ascending); notes before their declaration queue like any other signal.
  const outcomes = new Map<string, { text: string; by: string; at: number }>();
  const pendingOutcomes: { goalId: string; text: string; by: string; at: number }[] = [];
  // Retractions (goal-retract design) also live beside the skeleton: the newest retract vs the
  // newest declaration decides by ts, so a re-declaration after a retract un-retracts. Signals
  // before their declaration queue like outcomes do.
  const retractions = new Map<string, { by: string; at: number }>();
  const pendingRetractions: { goalId: string; by: string; at: number }[] = [];

  const applySignal = (act: string, meta: unknown, ts: number): boolean => {
    const goalId = signalGoalId(meta);
    if (goalId === null) return true; // a goal-less steer — no Goal to move; nothing pending.
    const acc = byId.get(goalId);
    if (!acc) return false; // target not (yet) declared — replay after all declarations are in.
    acc.epoch += 1;
    // ADR 257: a `defer` shelves, full stop. A pre-257 defer carrying `meta.wave: 3` meant "move it
    // to position 3"; replayed today it simply shelves, which is what the word always meant.
    if (act === 'defer') acc.waveEvents.push({ ts, wave: 'later' });
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
    // A Goal declaration or an outcome note (latest per id wins for the skeleton; its base wave is
    // a wave event). Both ride ordinary team messages — try the outcome shape first, it's cheaper.
    let rawMeta: unknown;
    try {
      rawMeta = JSON.parse(row.meta);
    } catch {
      continue;
    }
    const asOutcome = GoalOutcomeMetaSchema.safeParse(rawMeta);
    if (asOutcome.success) {
      const o = asOutcome.data.goal_outcome;
      const rec = { text: o.outcome, by: row.from_name, at: row.ts };
      if (byId.has(o.goal_id)) outcomes.set(o.goal_id, rec);
      else pendingOutcomes.push({ goalId: o.goal_id, ...rec });
      continue;
    }
    const asRetract = GoalRetractMetaSchema.safeParse(rawMeta);
    if (asRetract.success) {
      const r = asRetract.data.goal_retract;
      const rec = { by: row.from_name, at: row.ts };
      if (byId.has(r.goal_id)) retractions.set(r.goal_id, rec);
      else pendingRetractions.push({ goalId: r.goal_id, ...rec });
      continue;
    }
    let parsed: GoalDeclareMeta;
    try {
      parsed = GoalDeclareMetaSchema.parse(rawMeta);
    } catch {
      continue; // not a Goal declaration — an ordinary message with unrelated meta.
    }
    const g = parsed.goal;
    const prior = byId.get(g.id);
    byId.set(g.id, {
      id: g.id,
      title: g.title,
      // Wholesale replacement like the rest of the skeleton: an undeclared story clears, latest wins.
      ...(g.story !== undefined ? { story: g.story } : {}),
      depends_on: g.depends_on ?? [],
      declared_by: row.from_name,
      declared_at: row.ts,
      // A re-declaration replaces the skeleton wholesale but never erases accrued epoch/defer history.
      waveEvents: [
        ...(prior?.waveEvents ?? []),
        { ts: row.ts, wave: normalizeDeclaredWave(g.wave) },
      ],
      epoch: prior?.epoch ?? 0,
    });
  }
  // Replay signals that arrived before their Goal's declaration (rare, but order-independent now).
  for (const p of pending) applySignal(p.act, p.meta, p.ts);
  // Same for early outcome notes — the pending list is ts-ordered, so the last set is the latest.
  for (const p of pendingOutcomes)
    if (byId.has(p.goalId)) outcomes.set(p.goalId, { text: p.text, by: p.by, at: p.at });
  for (const p of pendingRetractions) {
    if (!byId.has(p.goalId)) continue;
    const prior = retractions.get(p.goalId);
    if (!prior || p.at >= prior.at) retractions.set(p.goalId, { by: p.by, at: p.at });
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
    id: g.id,
    title: g.title,
    ...(g.story !== undefined ? { story: g.story } : {}),
    ...(outcomes.has(g.id) ? { outcome: outcomes.get(g.id)! } : {}),
    // Retracted iff the newest retract postdates the newest declaration — latest signal wins.
    ...(retractions.has(g.id) && retractions.get(g.id)!.at >= g.declared_at
      ? { retracted: retractions.get(g.id)! }
      : {}),
    // Effective wave = the newest wave assertion (declaration or defer) by ts; ties keep the later push.
    wave: g.waveEvents.reduce((best, e) => (e.ts >= best.ts ? e : best)).wave,
    depends_on: g.depends_on,
    declared_by: g.declared_by,
    declared_at: g.declared_at,
    status: deriveGoalStatus(lanesByGoal.get(g.id) ?? []),
    epoch: g.epoch,
  }));
}

/**
 * The next Goal to pick up (ADR 049/084, reordered by ADR 257): the first `planned` Goal in
 * {@link compareGoals} order, skipping any still blocked by an unshipped `depends_on`. Pure — takes
 * the already-derived list from {@link listGoals}.
 *
 * Before 257 this sorted on the numeric wave, which only legacy CLI-era Goals carried; because unset
 * sorted last, every newly declared Goal was outranked by the oldest one on the board forever.
 */
export function nextGoal(goals: Goal[]): Goal | null {
  const shipped = new Set(goals.filter((g) => g.status === 'shipped').map((g) => g.id));
  const candidates = goals
    .filter((g) => g.status === 'planned' && g.retracted === undefined)
    .filter((g) => g.depends_on.every((d) => shipped.has(d)))
    .sort(compareGoals);
  return candidates[0] ?? null;
}
