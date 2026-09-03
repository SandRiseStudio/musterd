/**
 * Honest dwell: a short visit leaves a trace after it ends.
 *
 * The room already renders presence faithfully — a woken seat attaches, lights its desk, works, and
 * detaches. The problem is entirely one of *duration*: a codex wake that runs eleven seconds is on
 * screen for eleven seconds, and a reader who looked away sees a room that never changed. The visit
 * happened, was rendered, and left nothing behind. That is not a lie, but it is a surface that
 * cannot answer "did anything just happen here?", which is most of why anyone opens /live.
 *
 * So: after a seat departs, keep a small trace of the visit for a while.
 *
 * THE LINE THIS MUST NOT CROSS — a trace is a memory, never a presence. A seat that has left reads
 * as offline everywhere it already did: posture, chip, desk light, seating are all untouched by this
 * module, which is why it exports no predicate any of them could accidentally consume. The trace is
 * additive text in the past tense, and it says WHEN, so a reader is never working from "recently"
 * when they could be working from a number. This is the same line held for lapsed asks: a surface
 * may be slow to forget, and may never be wrong about now.
 *
 * SECOND LINE — it states only what this page watched. `arrivedAt` is set when THIS client first
 * sees the seat online, so it exists only for a visit whose beginning we witnessed. A seat that was
 * already in the room when the page loaded has an unknown arrival, and gets a trace that says it was
 * here and when it left, with NO duration. The roster's `last_seen_at` would let us guess one, and
 * guessing is exactly what makes a surface untrustworthy about the visits it did not see: an
 * eleven-second wake and a page opened eleven seconds ago are indistinguishable from the wire, and
 * only one of them is a wake worth showing. ADR 236 — absence is not an assertion.
 *
 * Web-only by design. The server refuses to own thresholds (protocol/src/member.ts:115-119,
 * "thresholds live in the CONSUMER"), and it is right to: how long a room remembers a visitor is a
 * property of the room, not of the fact.
 */

/** The minimal seat shape this module reads — satisfied by `MemberSummary`. */
export interface DwellSeat {
  name: string;
  presence: 'online' | 'away' | 'offline';
}

/** One seat's currently-remembered visit. */
export interface Visit {
  /** When THIS client first saw the seat online. Absent when the seat was already here — see the
   *  second line in the module header; its absence is why the trace can stay silent about length. */
  arrivedAt?: number;
  /** When this client last saw the seat present. The departure clock runs from here. */
  lastOnlineAt: number;
  /** Set once the seat has been observed offline. Its presence is what makes a return a NEW visit. */
  departed?: true;
}

export type DwellLog = Record<string, Visit>;

/**
 * How long a departed seat is remembered. Ninety seconds: long enough that a reader who glanced away
 * mid-wake still finds out it happened, short enough that the trace is always about the recent past
 * rather than a log. A room that remembers everyone forever is a log with furniture.
 */
export const DWELL_WINDOW_MS = 90_000;

/**
 * Fold one roster read into the log.
 *
 * Pure and total: same inputs, same output, no clock of its own — `now` is passed so tests state the
 * time they mean and the caller stays the only thing that reads a real clock.
 */
export function observeSeats(prev: DwellLog, seats: readonly DwellSeat[], now: number): DwellLog {
  const next: DwellLog = {};
  for (const seat of seats) {
    const before = prev[seat.name];
    if (seat.presence !== 'offline') {
      // Present now. A seat returning after its trace expired is a NEW visit, not a resumed one —
      // carrying the old arrival forward would report one long stay where there were two short ones,
      // which is the single most misleading thing this module could say.
      // A seat we have watched continuously keeps its arrival; one we saw leave starts over. The
      // trace reports CONTIGUOUS presence only — stitching a visit back across an observed absence
      // would report one long stay where there were two short ones, which is the most misleading
      // thing this module could say, and the flicker case is common (a wake that retries).
      next[seat.name] =
        before && !before.departed
          ? { ...before, lastOnlineAt: now }
          : { arrivedAt: now, lastOnlineAt: now };
      continue;
    }
    // Departed. Keep the visit only while its trace is still live, so the log is bounded by the
    // window rather than by how long the page has been open.
    if (before && now - before.lastOnlineAt <= DWELL_WINDOW_MS)
      next[seat.name] = { ...before, departed: true };
  }
  return next;
}

/**
 * Seconds-precise age. Deliberately NOT `format.ts`'s `coarseAge`, which collapses everything under a
 * minute to "now" — "now" is precisely the wrong word for a seat that has gone, and every visit this
 * module exists for is shorter than that floor.
 */
function briefAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
}

/**
 * What a seat's row may say about a visit that has ended, or `null` for the (usual) case of nothing
 * to add. Present and away seats always get `null`: they are here, and the room is already saying so.
 */
export function dwellTrace(
  log: DwellLog,
  seat: DwellSeat,
  now: number,
): { label: string; title: string } | null {
  if (seat.presence !== 'offline') return null;
  const visit = log[seat.name];
  if (!visit) return null;
  const since = now - visit.lastOnlineAt;
  if (since > DWELL_WINDOW_MS) return null;
  const stayed = visit.arrivedAt === undefined ? null : visit.lastOnlineAt - visit.arrivedAt;
  return {
    label: `was here · left ${briefAge(since)} ago`,
    title:
      stayed === null
        ? 'This seat was in the room a moment ago and has since gone offline. It was already here ' +
          'when this page loaded, so how long it stayed is not something this page can say.'
        : `This seat was in the room for ${briefAge(stayed)} and has since gone offline. ` +
          'Watched from this page, so the length covers the part of the visit it saw.',
  };
}
