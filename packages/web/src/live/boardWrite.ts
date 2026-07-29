// Pure decision logic for the writable board (item 5 / ADR 104) — every rule that decides *what a
// member may do to a lane* lives here, testable without DOM. The route/component layer renders these
// verdicts; the daemon remains the authority (these mirror, never replace, its checks).
import type { Goal, Lane, LaneBoard, LaneResult, LaneState, UpdateLane } from '@musterd/protocol';

/** A verb the board may offer on a card. `patch` is the exact `PATCH /lanes/:id` body. */
export interface LaneAction {
  kind:
    | 'claim'
    | 'start'
    | 'block'
    | 'unblock'
    | 'handoff'
    | 'ready'
    | 'done'
    | 'confirm'
    | 'sendback'
    | 'abandon';
  patch: UpdateLane;
}

const TERMINAL = new Set<Lane['state']>(['done', 'abandoned']);

/**
 * The verb-legality table. Two rules carry it all: an unowned lane is claimable by any member, and
 * only the owner moves an owned lane — you never touch a teammate's card (hand-off is the owner
 * *giving*, not a peer taking). Handoff's patch is a placeholder; the seat picker fills it via
 * {@link handoffPatch}.
 *
 * The one deliberate exception (ADR 169): a lane in `ready_for_review` offers its verbs to the
 * COUNTERPART, not the owner — `confirm` (the close that derives verified) and `sendback`. The
 * owner keeps only the degradation self-close (recorded unverified) plus abandon, so silence never
 * wedges. The owner's own "done" on a live lane became `ready` — the two-stage entry.
 */
export function laneActions(lane: Lane, me: string | null): LaneAction[] {
  if (!me || TERMINAL.has(lane.state)) return [];
  if (!lane.owner_seat) {
    // The daemon flips open→claimed itself when ownership lands (store/lanes.ts) — owner_seat alone.
    return [{ kind: 'claim', patch: { owner_seat: me } }];
  }
  if (lane.state === 'ready_for_review') {
    if (lane.owner_seat === me) {
      // The degradation path: the review ask timed out (or nobody was eligible) — self-close,
      // recorded unverified by the daemon. Never a wedge.
      return [
        { kind: 'done', patch: { state: 'done' } },
        { kind: 'abandon', patch: { state: 'abandoned' } },
      ];
    }
    return [
      { kind: 'confirm', patch: { state: 'done' } },
      { kind: 'sendback', patch: { state: 'active' } },
    ];
  }
  if (lane.owner_seat !== me) return [];
  const acts: LaneAction[] = [];
  if (lane.state === 'claimed') acts.push({ kind: 'start', patch: { state: 'active' } });
  if (lane.state === 'active') acts.push({ kind: 'block', patch: { state: 'blocked' } });
  if (lane.state === 'blocked') acts.push({ kind: 'unblock', patch: { state: 'active' } });
  acts.push({ kind: 'handoff', patch: {} });
  acts.push({ kind: 'ready', patch: { state: 'ready_for_review' } });
  acts.push({ kind: 'abandon', patch: { state: 'abandoned' } });
  return acts;
}

/** The handoff verb's real patch, once the seat picker has chosen. */
export function handoffPatch(seat: string): UpdateLane {
  return { owner_seat: seat };
}

/**
 * Fold a mutation echo into the board optimistically. The firehose deliberately skips the sender, so
 * this `{lane, warnings}` echo is the only copy the writing client sees (the AsksStrip precedent);
 * the next lane-event refetch reconciles with daemon truth. In-place replace keeps card order stable;
 * the echoed lane's warnings are authoritative-fresh, everyone else's are kept as-is.
 */
export function applyLaneEcho(board: LaneBoard, result: LaneResult): LaneBoard {
  const i = board.lanes.findIndex((l) => l.id === result.lane.id);
  const lanes =
    i === -1
      ? [...board.lanes, result.lane]
      : board.lanes.map((l, j) => (j === i ? result.lane : l));
  const warnings = [
    ...board.warnings.filter((w) => w.subject !== result.lane.id),
    ...result.warnings,
  ];
  return { lanes, warnings };
}

/** One swimlane band: a declared Goal (with derived status), an undeclared goal id, or "no goal". */
export interface GoalRow {
  id: string | null;
  title: string;
  status: Goal['status'] | null;
  lanes: Lane[];
}

/**
 * The swimlane view's regroup (Inc B) — pure reorganization of lanes already fetched + the report's
 * `goals` array, no extra fetch. Declared Goals keep their row even when empty (the plan is visible);
 * lanes naming an undeclared goal id band under that raw id; unassigned lanes band under "no goal",
 * last, and that row disappears when empty.
 */
export function groupByGoal(lanes: Lane[], goals: Goal[]): GoalRow[] {
  const byGoal = new Map<string | null, Lane[]>();
  for (const lane of lanes) {
    const key = lane.goal_id ?? null;
    const list = byGoal.get(key);
    if (list) list.push(lane);
    else byGoal.set(key, [lane]);
  }
  const rows: GoalRow[] = goals.map((g) => {
    const owned = byGoal.get(g.id) ?? [];
    byGoal.delete(g.id);
    return { id: g.id, title: g.title, status: g.status, lanes: owned };
  });
  for (const [id, orphans] of byGoal) {
    if (id === null) continue;
    rows.push({ id, title: id, status: null, lanes: orphans });
  }
  const unassigned = byGoal.get(null);
  if (unassigned && unassigned.length > 0) {
    rows.push({ id: null, title: 'no goal', status: null, lanes: unassigned });
  }
  return rows;
}

/** The filter-chip key for ownerless lanes — a name no seat can hold (seat names are word-shaped). */
export const UNOWNED = '∅';

/**
 * The member filter (polish pass): an empty selection means everyone — the chips are a lens, never a
 * gate. Selection keys are seat names, plus {@link UNOWNED} for the ownerless backlog.
 */
export function filterLanes(lanes: Lane[], owners: ReadonlySet<string>): Lane[] {
  if (owners.size === 0) return lanes;
  return lanes.filter((l) => owners.has(l.owner_seat ?? UNOWNED));
}

/** Column DOM guardrail (perf contract: no unbounded lists) — cap with an "…and K more" remainder. */
export function capColumn<T>(
  items: T[],
  cap: number,
  expanded: boolean,
): { shown: T[]; hidden: number } {
  if (expanded || items.length <= cap) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, cap), hidden: items.length - cap };
}

/** The two motion sets the board hands its cards: which moved, and which earned the flourish. */
export interface MovedLanes {
  landed: ReadonlySet<string>;
  flourished: ReadonlySet<string>;
}

/** Nothing moved — the first render, and the shared empty value so identity stays stable. */
export const NO_MOVES: MovedLanes = { landed: new Set(), flourished: new Set() };

/** A lane-id → state snapshot, the input `movedLanes` diffs against. */
export function laneStates(lanes: Lane[]): ReadonlyMap<string, LaneState> {
  return new Map(lanes.map((l) => [l.id, l.state]));
}

/**
 * Which cards changed column since the previous snapshot — `landed` animate in, `flourished` get the
 * warm beat.
 *
 * Pure, and deliberately so: this used to read a ref mid-render, which made the board's motion a
 * function of mutable state the renderer could not see and left it impossible to test. A diff of two
 * snapshots is the same logic with neither problem.
 *
 * The flourish fires on a CONFIRMED close only (ADR 169, miley's call): a counterpart said "this is
 * what I wanted". A self-close lands like any other move — no celebration for an unverified close,
 * and no beat at all on merely reaching `ready_for_review`.
 */
export function movedLanes(prev: ReadonlyMap<string, LaneState>, lanes: Lane[]): MovedLanes {
  const landed = new Set<string>();
  const flourished = new Set<string>();
  for (const lane of lanes) {
    const was = prev.get(lane.id);
    if (was === lane.state) continue;
    landed.add(lane.id);
    if (lane.state === 'done' && was !== undefined && lane.verified === true) flourished.add(lane.id);
  }
  return { landed, flourished };
}
