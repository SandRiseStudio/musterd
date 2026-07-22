import type { Activity } from '@musterd/protocol';

export interface ActivityResolution {
  activity: Activity;
  state: string | null;
  last_status_at: number | null;
}

/**
 * The two-clocks rule (ADR 010 / v0.2 M2; idle rename ADR 140), plus the steering signal (ADR 155
 * Increment 1). Independent clocks decide a member's activity:
 *  - **liveness** (presence heartbeat) gates `offline` vs. present;
 *  - **the latest `status_update`** gates `idle` (present, no reported task) vs. `working`;
 *  - **steering** — a human named as the `driver` of a *live* agent seat — marks `working` on its
 *    own, present even without the human's own heartbeat. "I steer, therefore I'm working" (ADR 155):
 *    steering *is* a real action (ADR 057), so it composes here at read time rather than through a
 *    synthetic presence row. It keeps the human's own status text as the label when there is one.
 *
 * For **agents**, once a live member has posted a status it reads `working` and never silently
 * reverts to `idle` while still alive — staleness (age of the status) is a *rendering* concern, not
 * a state change. Going offline (lost presence / grace expired) clears the working label.
 *
 * `idleAfterMs` is the ADR 155 Increment 3 idle heuristic, passed only for **human** members: a
 * human kept live by a persistent surface (an authenticated `/live` tab heartbeating for hours)
 * would otherwise wear one old `status_update` as `working` forever. Past the window the read decays
 * to `idle` — derived at read time, no stored state, no writer. `last_status_at` is kept (when they
 * last reported is still true); the stale text stops being worn as a live task label. Steering
 * outranks the decay: a live driver link is a *current* action, not a stale report.
 */
export function resolveActivity(
  live: boolean,
  lastStatus: { state: string; ts: number } | null,
  steering = false,
  idleAfterMs?: number,
): ActivityResolution {
  if (steering)
    return {
      activity: 'working',
      state: lastStatus?.state ?? null,
      last_status_at: lastStatus?.ts ?? null,
    };
  if (!live) return { activity: 'offline', state: null, last_status_at: null };
  if (lastStatus) {
    if (idleAfterMs !== undefined && Date.now() - lastStatus.ts > idleAfterMs)
      return { activity: 'idle', state: null, last_status_at: lastStatus.ts };
    return { activity: 'working', state: lastStatus.state, last_status_at: lastStatus.ts };
  }
  return { activity: 'idle', state: null, last_status_at: null };
}
