import type { FlowMetrics, Goal, GoalFlow, Lane, LaneWarning } from '@musterd/protocol';
import { compareGoals, isAwaitingAcceptance } from '@musterd/protocol/wire';

/**
 * The goals-grid front door (goals-front-door design) — the pure model behind `GoalGrid.tsx`.
 * Everything here is derivable from data the board page already fetches (`lanes` + `report.goals`);
 * no fetch, no DOM, so the whole layout is testable under the repo's node-only vitest.
 */

export type RunwayZone = 'backlog' | 'working' | 'review' | 'shipped';

export interface RunwayDot {
  lane: string;
  zone: RunwayZone;
  /** 0..100 — deterministic jitter within the zone band, stable across renders. */
  x: number;
  /** rider = claimed/active (renders the owner avatar); everything else is a dot. */
  kind: 'dot' | 'rider';
  tone: 'idle' | 'working' | 'blocked' | 'review' | 'done';
  owner: string | null;
  /** ✨ — the card's most recently resolved done lane. */
  latest: boolean;
  /**
   * value-layer design: this lane has been waiting on acceptance past the 12h threshold — review
   * debt, which is lane-shaped, so it lands on the dot rather than on the goal card. True iff the
   * daemon sent a `stale_acceptance` warning for it; we never re-derive the age (see
   * {@link GoalCardModel.staleNote}).
   */
  stale: boolean;
}

/** value-layer design: a goal's outcome note — what shipped changed. Evidence, not the promise. */
export interface OutcomeNote {
  text: string;
  by: string;
  at: number;
}

/** A goal that has shipped. `outcome: null` is review debt made visible, not a clean finish. */
export interface ShippedGoal {
  id: string;
  title: string;
  outcome: OutcomeNote | null;
}

export interface GoalCardModel {
  /** null = "Not on a goal yet"; undeclared ids keep the raw id. */
  id: string | null;
  title: string;
  /** goal.story, else a lane-facts fallback ("N lanes · started <rel>"), else null. */
  story: string | null;
  /**
   * value-layer design: the goal's outcome note, if one has been written. Deliberately NOT folded
   * into `story` — the story is the promise, the outcome is the evidence, and a card wants both.
   */
  outcome: OutcomeNote | null;
  /** false → "declare me" chip (a goal id lanes name but nobody declared). */
  declared: boolean;
  chip: 'queued' | 'just started' | 'in flight' | 'shipped' | 'lanes';
  dots: RunwayDot[];
  /** Dots beyond the cap — render "+N". */
  overflow: number;
  counts: { total: number; done: number; blocked: number; review: number; stale: number };
  /**
   * The daemon's own words for the oldest stale review on this card (`stale_acceptance.detail`,
   * e.g. "waiting 14h for acceptance — …"), or null. The number is quoted, never recomputed: the
   * server derives it from the `ready_for_review` audit row, which the client cannot see — a
   * client-side guess from `updated_at` would read younger than the truth every time a lane was
   * touched while it waited, and the board would contradict `team_next`.
   */
  staleNote: string | null;
  /** ⚡ pill — the card's most recently touched non-terminal lane. */
  lastMoved: { lane: string; title: string; at: number } | null;
  /**
   * The daemon's per-goal flow (ADR 295), or null when it sent none — a pre-295 server, or a goal
   * whose lanes it did not report. Quoted, never recomputed from `dots`: ADR 104 froze the rule
   * that analytics the board renders are derived server-side, so a client-side cycle time would be
   * a second, drifting answer to a question `GET /report` already answers.
   */
  flow: FlowMetrics | null;
}

export interface GoalGridModel {
  /** Wave-ordered; undeclared-id cards after declared; "Not on a goal yet" last; shipped excluded. */
  cards: GoalCardModel[];
  shippedShelf: ShippedGoal[];
  /** Team-wide latest done lane. */
  pulse: { title: string; at: number } | null;
}

export const RUNWAY_DOT_CAP = 14;

/** Zone bands on the 0..100 runway. */
const ZONE_BAND: Record<RunwayZone, [start: number, width: number]> = {
  backlog: [0, 25],
  working: [25, 25],
  review: [50, 25],
  shipped: [75, 25],
};

/** djb2 — small deterministic string hash for stable jitter. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function zoneOf(state: Lane['state']): RunwayZone | null {
  if (state === 'open') return 'backlog';
  if (state === 'claimed' || state === 'active' || state === 'blocked') return 'working';
  if (isAwaitingAcceptance(state)) return 'review';
  if (state === 'done') return 'shipped';
  return null; // abandoned — excluded
}

function toneOf(state: Lane['state']): RunwayDot['tone'] {
  if (state === 'open') return 'idle';
  if (state === 'blocked') return 'blocked';
  if (isAwaitingAcceptance(state)) return 'review';
  if (state === 'done') return 'done';
  return 'working';
}

function relAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ago`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ago`;
  if (s >= 60) return `${Math.floor(s / 60)}m ago`;
  return 'just now';
}

function buildDots(
  lanes: Lane[],
  stale: Map<string, string>,
): { dots: RunwayDot[]; overflow: number } {
  const latestDone = lanes
    .filter((l) => l.state === 'done')
    .reduce<Lane | null>(
      (best, l) =>
        best === null || (l.resolved_at ?? 0) > (best.resolved_at ?? 0) ? l : best,
      null,
    );
  const all: RunwayDot[] = [];
  for (const l of lanes) {
    const zone = zoneOf(l.state);
    if (zone === null) continue;
    const [start, width] = ZONE_BAND[zone];
    all.push({
      lane: l.id,
      zone,
      x: start + (hash(l.id) % width),
      kind: l.state === 'claimed' || l.state === 'active' ? 'rider' : 'dot',
      tone: toneOf(l.state),
      owner: l.owner_seat,
      latest: latestDone !== null && l.id === latestDone.id,
      stale: stale.has(l.id),
    });
  }
  return { dots: all.slice(0, RUNWAY_DOT_CAP), overflow: Math.max(0, all.length - RUNWAY_DOT_CAP) };
}

function buildCard(
  id: string | null,
  title: string,
  declared: boolean,
  goal: Goal | null,
  lanes: Lane[],
  now: number,
  stale: Map<string, string>,
  flow: FlowMetrics | null,
): GoalCardModel {
  const live = lanes.filter((l) => l.state !== 'abandoned');
  const done = live.filter((l) => l.state === 'done').length;
  const staleHere = live.filter((l) => stale.has(l.id));
  const counts = {
    total: live.length,
    done,
    blocked: live.filter((l) => l.state === 'blocked').length,
    review: live.filter((l) => isAwaitingAcceptance(l.state)).length,
    stale: staleHere.length,
  };

  let chip: GoalCardModel['chip'];
  if (id === null) chip = 'lanes';
  else {
    // Derived status for undeclared cards mirrors the server's deriveGoalStatus.
    const status =
      goal?.status ??
      (live.length === 0
        ? 'planned'
        : live.every((l) => l.state === 'done' || l.state === 'abandoned') && done > 0
          ? 'shipped'
          : 'in-flight');
    if (status === 'planned') chip = 'queued';
    else if (status === 'shipped') chip = 'shipped';
    else chip = done === 0 ? 'just started' : 'in flight';
  }

  let story: string | null = goal?.story ?? null;
  if (story === null && live.length > 0) {
    const started = Math.min(...live.map((l) => l.created_at));
    story = `${live.length} lane${live.length === 1 ? '' : 's'} · started ${relAge(now - started)}`;
  }

  const movers = live.filter((l) => l.state !== 'done');
  const lastMoved = movers.reduce<Lane | null>(
    (best, l) => (best === null || l.updated_at > best.updated_at ? l : best),
    null,
  );

  // The oldest wait leads: the daemon lists lanes in creation order, so the first stale one is the
  // longest-suffering, and its own sentence is what the card quotes.
  const staleNote = staleHere.length > 0 ? (stale.get(staleHere[0]!.id) ?? null) : null;

  const { dots, overflow } = buildDots(live, stale);
  return {
    id,
    title,
    story,
    outcome: goal?.outcome ?? null,
    declared,
    chip,
    dots,
    overflow,
    counts,
    staleNote,
    lastMoved: lastMoved
      ? { lane: lastMoved.id, title: lastMoved.title, at: lastMoved.updated_at }
      : null,
    flow,
  };
}

/**
 * @param warnings the board's live lane warnings — only `stale_acceptance` is read, and only to
 *   mark review debt. Omitting them costs the debt render, never correctness.
 */
export function buildGoalGrid(
  lanes: Lane[],
  goals: Goal[],
  now: number,
  warnings: LaneWarning[] = [],
  /** `report.goal_flow` (ADR 295); empty against a pre-295 daemon, which leaves every card's
   *  `flow` null and the grid rendering exactly as it did before. */
  goalFlow: GoalFlow[] = [],
): GoalGridModel {
  const flowByGoal = new Map<string | null, FlowMetrics>(
    goalFlow.map((g) => [g.goal_id, g.flow]),
  );
  const flowOf = (id: string | null) => flowByGoal.get(id) ?? null;
  const stale = new Map<string, string>();
  for (const w of warnings) {
    if (w.kind === 'stale_acceptance' && !stale.has(w.subject)) stale.set(w.subject, w.detail);
  }
  // goal-retract design: a withdrawn Goal renders no card and no shelf entry. Its lanes are NOT
  // dropped — with the id gone from declaredIds they fall to the undeclared-goal card, so work
  // attached to a retracted goal stays visible (the ADR 257 silent-delete scar).
  const visibleGoals = goals.filter((g) => g.retracted === undefined);
  const active = lanes.filter((l) => l.state !== 'abandoned');
  const doneLanes = active.filter((l) => l.state === 'done' && l.resolved_at !== null);
  const latest = doneLanes.reduce<Lane | null>(
    (best, l) => (best === null || l.resolved_at! > best.resolved_at! ? l : best),
    null,
  );
  const pulse = latest ? { title: latest.title, at: latest.resolved_at! } : null;

  // No declared goals AT ALL: the grid has nothing to lead with — the route falls back to columns.
  // (All-retracted is different: the grid still builds, so lanes on retracted goals stay visible.)
  if (goals.length === 0) return { cards: [], shippedShelf: [], pulse };

  const byGoal = new Map<string | null, Lane[]>();
  for (const l of active) {
    const key = l.goal_id ?? null;
    const list = byGoal.get(key);
    if (list) list.push(l);
    else byGoal.set(key, [l]);
  }

  const cards: GoalCardModel[] = [];
  const shippedShelf: ShippedGoal[] = [];
  for (const g of [...visibleGoals].sort(compareGoals)) {
    const owned = byGoal.get(g.id) ?? [];
    byGoal.delete(g.id);
    if (g.status === 'shipped') {
      shippedShelf.push({ id: g.id, title: g.title, outcome: g.outcome ?? null });
      continue;
    }
    cards.push(buildCard(g.id, g.title, true, g, owned, now, stale, flowOf(g.id)));
  }
  const declaredIds = new Set(visibleGoals.map((g) => g.id));
  for (const [id, orphans] of byGoal) {
    if (id === null || declaredIds.has(id)) continue;
    cards.push(buildCard(id, id, false, null, orphans, now, stale, flowOf(id)));
  }
  const unassigned = byGoal.get(null);
  if (unassigned && unassigned.length > 0) {
    cards.push(buildCard(null, 'Not on a goal yet', true, null, unassigned, now, stale, flowOf(null)));
  }
  return { cards, shippedShelf, pulse };
}

/**
 * Which view the board opens on. `'columns'` stored → columns; `'grid'` (or the legacy `'goals'`
 * value the swimlane era persisted) → grid; nothing stored → grid iff the team has unshipped goals,
 * else columns (a goal-less team's grid would be an empty stage).
 */
export function resolveBoardView(stored: string | null, goalCount: number): 'grid' | 'columns' {
  if (stored === 'columns') return 'columns';
  if (stored === 'grid' || stored === 'goals') return 'grid';
  return goalCount > 0 ? 'grid' : 'columns';
}

/**
 * The drill-in lens: `undefined` = no filter; `null` = goal-less lanes only; an id = that goal's
 * lanes. Pure so the route stays wiring.
 */
export function goalFilter(lanes: Lane[], goalId: string | null | undefined): Lane[] {
  if (goalId === undefined) return lanes;
  return lanes.filter((l) => (l.goal_id ?? null) === goalId);
}
