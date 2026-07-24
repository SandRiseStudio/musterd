import type { Envelope, Lane, LaneBoard, LaneState, MemberSummary } from '@musterd/protocol';
import { laneEvent } from './format';

/**
 * The overlay's pure derivation. Every decision the working-on strap makes lives here, so the
 * component stays thin JSX and the behaviour is testable in a node environment (this repo has no
 * jsdom — see vitest.config.ts).
 */

/** A lane as the strap renders it — deliberately narrower than `Lane`, so the view cannot drift. */
export interface WorkingOnEntry {
  id: string;
  title: string;
  owner: string;
  state: LaneState;
}

/** In-flight = someone is on it right now. `done`/`abandoned` are history, not work. */
const IN_FLIGHT: readonly LaneState[] = ['claimed', 'active', 'blocked'];

/** Most-recent activity first: when a lane was claimed, else when it last moved. */
function recency(lane: Lane): number {
  return lane.claimed_at ?? lane.updated_at;
}

/**
 * The lanes worth putting on screen: owned, in flight, freshest first, capped at `limit`.
 * A null board (not yet fetched) yields nothing rather than a flash of empty chrome.
 */
export function workingOn(board: LaneBoard | null, limit: number): WorkingOnEntry[] {
  if (!board) return [];
  return board.lanes
    .filter((l) => l.owner_seat !== null && IN_FLIGHT.includes(l.state))
    .sort((a, b) => recency(b) - recency(a))
    .slice(0, limit)
    .map((l) => ({ id: l.id, title: l.title, owner: l.owner_seat as string, state: l.state }));
}

/** How many teammates are in the room. Offline is the only absence (ADR 010 hides grace). */
export function presentCount(roster: MemberSummary[]): number {
  return roster.filter((m) => m.presence !== 'offline').length;
}

/**
 * Does this envelope mean the lane board changed? Lane acts are self-announcing on the firehose both
 * routes already subscribe to, so this is the whole refresh trigger — there is no polling, and
 * ordinary chatter costs a viewer nothing.
 */
export function invalidatesLanes(env: Pick<Envelope, 'act' | 'meta'>): boolean {
  return laneEvent(env) !== null;
}
