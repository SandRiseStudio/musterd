import type { Activity } from '@musterd/protocol';

export interface ActivityResolution {
  activity: Activity;
  state: string | null;
  last_status_at: number | null;
}

/**
 * The two-clocks rule (ADR 010 / v0.2 M2). Two independent clocks decide a member's activity:
 *  - **liveness** (presence heartbeat) gates `offline` vs. present;
 *  - **the latest `status_update`** gates `online` (present, no reported task) vs. `working`.
 *
 * Once a live member has posted a status, it reads `working` and never silently reverts to
 * `online`/idle while still alive — staleness (age of the status) is a *rendering* concern, not
 * a state change. Going offline (lost presence / grace expired) clears the working label.
 */
export function resolveActivity(
  live: boolean,
  lastStatus: { state: string; ts: number } | null,
): ActivityResolution {
  if (!live) return { activity: 'offline', state: null, last_status_at: null };
  if (lastStatus)
    return { activity: 'working', state: lastStatus.state, last_status_at: lastStatus.ts };
  return { activity: 'online', state: null, last_status_at: null };
}
