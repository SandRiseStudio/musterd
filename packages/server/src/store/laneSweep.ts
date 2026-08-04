import { type Lane, isAwaitingAcceptance } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { type Closer, recordLaneClose } from './laneClose.js';
import { listLanes, updateLane } from './lanes.js';

/**
 * The backstop sweep (ADR 229): close a lane that has waited past the grace period in
 * `awaiting_acceptance`, because nothing else ever will.
 *
 * `review_timeout` and its ADR 217 siblings are computed inside `recordLaneClose` — they LABEL a
 * close somebody else initiated and never cause one. Nothing else reads lane state on a timer. So a
 * lane whose worker's session ended before it gave up waiting has no actor left: five were found
 * stranded in a single session on 2026-08-04, one of them for 90 hours with its own merge
 * attestation already attached.
 */

/**
 * How long a lane must sit in `awaiting_acceptance` before the sweep will touch it.
 *
 * 24h, and the number is the whole safety argument rather than a default someone liked. Lanes that
 * DID eventually close had a 12.29h mean time-in-review, so the grace is near double the typical
 * eventual close: a lane must have already outlived the normal path before the sweep can reach it.
 * That is what stops this becoming the primary close path — not care, but arithmetic. Lower it and
 * the sweep starts competing with acceptance instead of collecting after it, which is the failure
 * ADR 229's Eval pre-registers a falsifier for.
 */
export const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The system as a closer. `kind: 'system'` is load-bearing, not decorative: `recordLaneClose`
 * derives verified-ness as "a seat other than the owner closed it", which the system satisfies
 * trivially — so without this the sweep would record every swept lane as a `counterpart_confirm`,
 * inventing cross-seat reviews that never happened and feeding them to the ADR 056 diversity
 * conclusions that read exactly that field.
 */
export const SYSTEM_CLOSER: Closer = { name: 'musterd', kind: 'system' };

/** What the sweep closed, for the caller's log. */
export interface SweptLane {
  id: string;
  owner_seat: string | null;
  waited_ms: number;
}

/**
 * Close every lane that has waited past the grace. Returns what it closed.
 *
 * READS, and writes only when it closes. `recordLaneClose` derives `time_in_review_ms` from
 * `updated_at` on the assumption that entering review was the lane's last update, so a sweep that
 * stamped lanes while inspecting them would silently corrupt that figure for every later close —
 * including the human-accepted ones this is not even about.
 */
export function sweepAbandonedAcceptance(
  db: Database,
  teamId: string,
  teamSlug: string,
  now: number,
  graceMs: number = SWEEP_GRACE_MS,
): SweptLane[] {
  const swept: SweptLane[] = [];
  for (const before of listLanes(db, teamId, teamSlug)) {
    if (!isAwaitingAcceptance(before.state)) continue;
    const waited = now - before.updated_at;
    if (waited < graceMs) continue;

    const lane: Lane | null = updateLane(db, teamId, before.id, teamSlug, { state: 'done' }, now);
    if (!lane) continue;
    // The merge attestation the lane already carries rides through untouched — a swept lane is
    // still a landed one, and dropping its PR/SHA would break the ADR 109 seat→PR→SHA join for
    // exactly the lanes nobody was watching.
    recordLaneClose(db, teamId, SYSTEM_CLOSER, before, lane);
    swept.push({ id: before.id, owner_seat: before.owner_seat, waited_ms: waited });
  }
  return swept;
}
