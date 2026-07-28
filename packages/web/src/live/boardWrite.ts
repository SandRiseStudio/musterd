// Pure decision logic for the writable board (item 5 / ADR 104) — every rule that decides *what a
// member may do to a lane* lives here, testable without DOM. The route/component layer renders these
// verdicts; the daemon remains the authority (these mirror, never replace, its checks).
import type { Lane, LaneBoard, LaneResult, UpdateLane } from '@musterd/protocol';

/** A verb the board may offer on a card. `patch` is the exact `PATCH /lanes/:id` body. */
export interface LaneAction {
  kind: 'claim' | 'start' | 'block' | 'unblock' | 'handoff' | 'done' | 'abandon';
  patch: UpdateLane;
}

const TERMINAL = new Set<Lane['state']>(['done', 'abandoned']);

/**
 * The verb-legality table. Two rules carry it all: an unowned lane is claimable by any member, and
 * only the owner moves an owned lane — you never touch a teammate's card (hand-off is the owner
 * *giving*, not a peer taking). Handoff's patch is a placeholder; the seat picker fills it via
 * {@link handoffPatch}.
 */
export function laneActions(lane: Lane, me: string | null): LaneAction[] {
  if (!me || TERMINAL.has(lane.state)) return [];
  if (!lane.owner_seat) {
    // The daemon flips open→claimed itself when ownership lands (store/lanes.ts) — owner_seat alone.
    return [{ kind: 'claim', patch: { owner_seat: me } }];
  }
  if (lane.owner_seat !== me) return [];
  const acts: LaneAction[] = [];
  if (lane.state === 'claimed') acts.push({ kind: 'start', patch: { state: 'active' } });
  if (lane.state === 'active') acts.push({ kind: 'block', patch: { state: 'blocked' } });
  if (lane.state === 'blocked') acts.push({ kind: 'unblock', patch: { state: 'active' } });
  acts.push({ kind: 'handoff', patch: {} });
  acts.push({ kind: 'done', patch: { state: 'done' } });
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

/** Column DOM guardrail (perf contract: no unbounded lists) — cap with an "…and K more" remainder. */
export function capColumn<T>(
  items: T[],
  cap: number,
  expanded: boolean,
): { shown: T[]; hidden: number } {
  if (expanded || items.length <= cap) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, cap), hidden: items.length - cap };
}
