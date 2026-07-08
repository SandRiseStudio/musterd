import type { Lane, LaneWarning } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { goalEpochBumps } from './goals.js';
import { listLanes } from './lanes.js';

/**
 * Stale-plan detection (ADR 109 — ADR 088 increment 3, design §5): catch work built against a
 * superseded plan **when the interrupt line missed** (mid-generation, a long command, an approval-parked
 * agent). The interrupt line shrinks the deaf window; it never closes it. This is the semantic backstop.
 *
 * It rides what already exists — no new state. A Goal's **epoch** is the count of direction-changing
 * acts (`defer`s + goal-scoped `steer`s) that have landed on it (see {@link goalEpochBumps}); a lane
 * records when it was claimed. If a lane's Goal is on a higher epoch now than when the lane was claimed,
 * the plan moved under it. Two owner-directed, warn-only signals fall out — never broadcast (the line
 * between an interrupt fabric and a noise fabric, ADR 083 doctrine):
 *
 *   - **`stale_plan`** — a live owned lane whose own Goal advanced an epoch since the lane was claimed.
 *   - **`stale_dependency`** — a live owned lane building on another lane whose Goal advanced. This is
 *     directory-based cache coherence: the `goal_id` join + the `depends_on` edge are the directory
 *     entries that route the invalidation to exactly the lane that inherited the moved assumption. The
 *     P3 dogfood's dependency-revert (53% of that session's waste) is precisely this miss.
 */

/** Lane states that are actively being worked — the only ones worth a staleness wake. */
const LIVE_OWNED: ReadonlySet<string> = new Set(['claimed', 'active', 'blocked']);

/** When the owner started building against the plan: the claim, else the declaration timestamp. */
function baseline(lane: Lane): number {
  return lane.claimed_at ?? lane.created_at;
}

/** How many of a Goal's epoch bumps had landed at or before `ts` — the epoch a lane opened against. */
function epochAt(bumps: number[] | undefined, ts: number): number {
  if (!bumps) return 0;
  let n = 0;
  for (const b of bumps) if (b <= ts) n += 1;
  return n;
}

/**
 * The current stale-lane warnings for the team (the two ADR 109 kinds). `onlyGoal` scopes the scan to a
 * single Goal — the just-deferred/steered one — for the directed push a `defer`/`steer` fires; omitted,
 * it returns the whole current stale set (the board read, and `team_next` enrichment).
 */
export function staleLaneWarnings(
  db: Database,
  teamId: string,
  teamSlug: string,
  onlyGoal?: string,
): LaneWarning[] {
  const bumps = goalEpochBumps(db, teamId);
  if (bumps.size === 0) return []; // no direction has changed on any Goal — nothing can be stale.
  const lanes = listLanes(db, teamId, teamSlug);
  const byId = new Map(lanes.map((l) => [l.id, l]));
  const out: LaneWarning[] = [];

  for (const lane of lanes) {
    if (lane.owner_seat === null || !LIVE_OWNED.has(lane.state)) continue;
    const base = baseline(lane);

    // stale_plan — this lane's own Goal moved since it was claimed.
    if (lane.goal_id !== null && (onlyGoal === undefined || lane.goal_id === onlyGoal)) {
      const b = bumps.get(lane.goal_id);
      const current = b?.length ?? 0;
      const atOpen = epochAt(b, base);
      if (current > atOpen) {
        out.push({
          kind: 'stale_plan',
          subject: lane.id,
          with: lane.goal_id,
          owner: lane.owner_seat,
          detail: `plan moved under "${lane.title}": goal ${lane.goal_id} is on epoch ${current}, you claimed against epoch ${atOpen} — re-check direction`,
        });
      }
    }

    // stale_dependency — a lane this one builds on had its Goal moved since this lane was claimed.
    for (const depId of lane.depends_on) {
      const dep = byId.get(depId);
      if (!dep || dep.goal_id === null) continue;
      if (onlyGoal !== undefined && dep.goal_id !== onlyGoal) continue;
      const b = bumps.get(dep.goal_id);
      const current = b?.length ?? 0;
      const atOpen = epochAt(b, base);
      if (current > atOpen) {
        out.push({
          kind: 'stale_dependency',
          subject: lane.id,
          with: depId,
          owner: lane.owner_seat,
          detail: `dependency "${dep.title}" (owner ${dep.owner_seat ?? 'unowned'}) had its plan moved: goal ${dep.goal_id} is on epoch ${current} since you claimed — re-check the interface`,
        });
      }
    }
  }
  return out;
}
