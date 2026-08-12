import type { Goal, Lane } from '@musterd/protocol';
import { isAwaitingAcceptance } from '@musterd/protocol';

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
}

export interface GoalCardModel {
  /** null = "Not on a goal yet"; undeclared ids keep the raw id. */
  id: string | null;
  title: string;
  /** goal.story, else a lane-facts fallback ("N lanes · started <rel>"), else null. */
  story: string | null;
  /** false → "declare me" chip (a goal id lanes name but nobody declared). */
  declared: boolean;
  chip: 'queued' | 'just started' | 'in flight' | 'shipped' | 'lanes';
  dots: RunwayDot[];
  /** Dots beyond the cap — render "+N". */
  overflow: number;
  counts: { total: number; done: number; blocked: number; review: number };
  /** ⚡ pill — the card's most recently touched non-terminal lane. */
  lastMoved: { lane: string; title: string; at: number } | null;
}

export interface GoalGridModel {
  /** Wave-ordered; undeclared-id cards after declared; "Not on a goal yet" last; shipped excluded. */
  cards: GoalCardModel[];
  shippedShelf: { id: string; title: string }[];
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

function waveRank(wave: Goal['wave']): number {
  return wave === null || wave === 'later' ? Number.POSITIVE_INFINITY : wave;
}

function buildDots(lanes: Lane[]): { dots: RunwayDot[]; overflow: number } {
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
): GoalCardModel {
  const live = lanes.filter((l) => l.state !== 'abandoned');
  const done = live.filter((l) => l.state === 'done').length;
  const counts = {
    total: live.length,
    done,
    blocked: live.filter((l) => l.state === 'blocked').length,
    review: live.filter((l) => isAwaitingAcceptance(l.state)).length,
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

  const { dots, overflow } = buildDots(live);
  return {
    id,
    title,
    story,
    declared,
    chip,
    dots,
    overflow,
    counts,
    lastMoved: lastMoved
      ? { lane: lastMoved.id, title: lastMoved.title, at: lastMoved.updated_at }
      : null,
  };
}

export function buildGoalGrid(lanes: Lane[], goals: Goal[], now: number): GoalGridModel {
  const active = lanes.filter((l) => l.state !== 'abandoned');
  const doneLanes = active.filter((l) => l.state === 'done' && l.resolved_at !== null);
  const latest = doneLanes.reduce<Lane | null>(
    (best, l) => (best === null || l.resolved_at! > best.resolved_at! ? l : best),
    null,
  );
  const pulse = latest ? { title: latest.title, at: latest.resolved_at! } : null;

  // No declared goals: the grid has nothing to lead with — the route falls back to columns.
  if (goals.length === 0) return { cards: [], shippedShelf: [], pulse };

  const byGoal = new Map<string | null, Lane[]>();
  for (const l of active) {
    const key = l.goal_id ?? null;
    const list = byGoal.get(key);
    if (list) list.push(l);
    else byGoal.set(key, [l]);
  }

  const cards: GoalCardModel[] = [];
  const shippedShelf: { id: string; title: string }[] = [];
  for (const g of [...goals].sort((a, b) => waveRank(a.wave) - waveRank(b.wave))) {
    const owned = byGoal.get(g.id) ?? [];
    byGoal.delete(g.id);
    if (g.status === 'shipped') {
      shippedShelf.push({ id: g.id, title: g.title });
      continue;
    }
    cards.push(buildCard(g.id, g.title, true, g, owned, now));
  }
  const declaredIds = new Set(goals.map((g) => g.id));
  for (const [id, orphans] of byGoal) {
    if (id === null || declaredIds.has(id)) continue;
    cards.push(buildCard(id, id, false, null, orphans, now));
  }
  const unassigned = byGoal.get(null);
  if (unassigned && unassigned.length > 0) {
    cards.push(buildCard(null, 'Not on a goal yet', true, null, unassigned, now));
  }
  return { cards, shippedShelf, pulse };
}
