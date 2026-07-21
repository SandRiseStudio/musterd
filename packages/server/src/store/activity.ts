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
 * Once a live member has posted a status, it reads `working` and never silently reverts to
 * `idle` while still alive — staleness (age of the status) is a *rendering* concern, not
 * a state change. Going offline (lost presence / grace expired) clears the working label.
 */
export function resolveActivity(
  live: boolean,
  lastStatus: { state: string; ts: number } | null,
  steering = false,
): ActivityResolution {
  if (steering)
    return {
      activity: 'working',
      state: lastStatus?.state ?? null,
      last_status_at: lastStatus?.ts ?? null,
    };
  if (!live) return { activity: 'offline', state: null, last_status_at: null };
  if (lastStatus)
    return { activity: 'working', state: lastStatus.state, last_status_at: lastStatus.ts };
  return { activity: 'idle', state: null, last_status_at: null };
}
