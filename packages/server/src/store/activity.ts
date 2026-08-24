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
 *  - **the latest `status_update`** gates `active` (present, no fresh claim) vs. `working`;
 *  - **steering** — a human named as the `driver` of a *live* agent seat — marks `working` on its
 *    own, present even without the human's own heartbeat. "I steer, therefore I'm working" (ADR 155):
 *    steering *is* a real action (ADR 057), so it composes here at read time rather than through a
 *    synthetic presence row. It keeps the human's own status text as the label when there is one.
 *
 * `idleAfterMs` is the ADR 155 Increment 3 decay heuristic, now passed for **everyone**
 * (presence-honesty §2.1): humans keep the presence timeout; agents get their own generous window
 * (`agentIdleMs`) — `working` requires *fresh* evidence. Past the window the read decays to
 * `active` (the wire rename of `idle`), derived at read time, no stored state, no writer — and the
 * claim is KEPT with its age: `state` and `last_status_at` survive so the renderer can say
 * `last: "<status>" · 20m ago` instead of erasing history. Steering outranks the decay: a live
 * driver link is a *current* action, not a stale report. With no window passed the ADR 010
 * never-silently-revert read holds.
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
      return { activity: 'active', state: lastStatus.state, last_status_at: lastStatus.ts };
    return { activity: 'working', state: lastStatus.state, last_status_at: lastStatus.ts };
  }
  return { activity: 'active', state: null, last_status_at: null };
}
