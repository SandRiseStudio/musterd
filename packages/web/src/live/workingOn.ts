import type { Envelope, Lane, LaneBoard, LaneState, MemberSummary } from '@musterd/protocol';
import type { Posture } from '@musterd/protocol';
import { laneEvent, memberColor, memberPosture } from './format';

/**
 * The overlay's pure derivation. Every decision the room reel makes lives here, so the component
 * stays thin JSX and the behaviour is testable in a node environment (this repo has no jsdom — see
 * vitest.config.ts).
 *
 * **The unit is a member, not a lane** (nick, 2026-07-28: "I want to ... advance through what the
 * members are working on"). A lane list silently omits everyone without one, which is the wrong
 * answer to "who is in this room and what are they doing" — the teammate sitting idle is a fact
 * about the team, not an absence of one. So the reel is the roster, ordered by how much it has to
 * say, and each entry answers what that person is on.
 */

/** In-flight = someone is on it right now. `done`/`abandoned` are history, not work. */
const IN_FLIGHT: readonly LaneState[] = ['claimed', 'active', 'blocked'];

/** Most-recent activity first: when a lane was claimed, else when it last moved. */
function recency(lane: Lane): number {
  return lane.claimed_at ?? lane.updated_at;
}

/** One person in the room, and what they are on. */
export interface RoomEntry {
  /** The member's name — their identity, and the reel's stable React key. */
  name: string;
  kind: 'agent' | 'human';
  /** The same `memberColor` the floor paints their body with, so the reel's dot IS that person. */
  color: string;
  posture: Posture;
  /** What they are on: their freshest in-flight lane's title, else their own status line, else null. */
  title: string | null;
  /** Where `title` came from. Rendered, because a claimed lane and a self-reported line are not the
   *  same kind of fact and the overlay should not blur them. */
  source: 'lane' | 'status' | null;
  /** The lane's state — set only when `source === 'lane'`. */
  laneState: LaneState | null;
  /** Further in-flight lanes this member owns beyond the one shown. Usually 0. */
  moreLanes: number;
}

/** Rank for the reel's order: the more a member has to report, the earlier they appear. */
function rank(entry: RoomEntry): number {
  if (entry.source === 'lane') return 0;
  if (entry.source === 'status') return 1;
  return 2;
}

/**
 * Everyone in the room, ordered by how much they have to say: lane owners first (freshest lane
 * first), then members reporting a status line, then whoever has nothing claimed. Offline members
 * are excluded — they are not in the room (ADR 010 hides grace, so offline is the only absence).
 *
 * A null board (not yet fetched) is not an empty board: members still appear, carrying their own
 * status lines, so the reel never blanks while the lane fetch is in flight.
 */
export function roomEntries(roster: MemberSummary[], board: LaneBoard | null): RoomEntry[] {
  const owned = new Map<string, Lane[]>();
  for (const lane of board?.lanes ?? []) {
    if (lane.owner_seat === null || !IN_FLIGHT.includes(lane.state)) continue;
    const list = owned.get(lane.owner_seat);
    if (list) list.push(lane);
    else owned.set(lane.owner_seat, [lane]);
  }
  for (const list of owned.values()) list.sort((a, b) => recency(b) - recency(a));

  const entries = roster
    .filter((m) => m.presence !== 'offline')
    .map((m): RoomEntry => {
      const kind = m.kind === 'human' ? 'human' : 'agent';
      const lanes = owned.get(m.name) ?? [];
      const lane = lanes[0];
      const status = m.state?.trim() ? m.state.trim() : null;
      return {
        name: m.name,
        kind,
        color: memberColor(m.name, kind),
        posture: memberPosture(m),
        title: lane ? lane.title : status,
        source: lane ? 'lane' : status ? 'status' : null,
        laneState: lane ? lane.state : null,
        moreLanes: Math.max(0, lanes.length - 1),
      };
    });

  // Stable within a rank: lane owners by lane recency, status-only by how recently they reported,
  // and the quiet ones alphabetically so the tail of the reel does not reshuffle on every refresh.
  const laneRecency = new Map(
    [...owned].map(([name, lanes]) => [name, recency(lanes[0]!)] as const),
  );
  const statusAt = new Map(roster.map((m) => [m.name, m.last_status_at ?? 0] as const));
  return entries.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.source === 'lane') return (laneRecency.get(b.name) ?? 0) - (laneRecency.get(a.name) ?? 0);
    if (a.source === 'status') return (statusAt.get(b.name) ?? 0) - (statusAt.get(a.name) ?? 0);
    return a.name.localeCompare(b.name);
  });
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
