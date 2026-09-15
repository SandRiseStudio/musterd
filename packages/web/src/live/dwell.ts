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
 * SECOND LINE — it states only what this page watched. `arrivedAt` exists only for a visit whose
 * beginning we witnessed, and witnessing an arrival means having first read the seat NOT here: the
 * fold sets it on an observed absent→present transition and at no other moment. A seat that was
 * already in the room when the page loaded therefore has an unknown arrival, and gets a trace that
 * says it was here and when it left, with NO duration. The roster's `last_seen_at` would let us
 * guess one, and guessing is exactly what makes a surface untrustworthy about the visits it did not
 * see: an eleven-second wake and a page opened eleven seconds ago are indistinguishable from the
 * wire, and only one of them is a wake worth showing. ADR 236 — absence is not an assertion.
 *
 * "The first read of the page" is deliberately not a flag anyone has to remember to pass. It was
 * one, briefly, and it is the wrong shape: `useLiveStream` hands out `[]` until the backfill lands,
 * so the first FOLD is over an empty roster and the first real read is the second one — a flag set
 * on call number one would have re-armed the exact lie it was added to stop. The log itself is the
 * record instead: every seat in a roster read is remembered, offline ones included, and only a name
 * we have already read absent can arrive. A roster carries the whole team with a presence each, so
 * an empty room reads as "all offline" rather than as "no seats", and the honest wake case — a seat
 * read offline, then online — still names its length.
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

/** One seat's currently-remembered visit — or, for a seat only ever read offline, the bare fact that
 *  this page has watched it be absent, which is what lets its next arrival be a witnessed one. */
export interface Visit {
  /** When THIS client watched the seat arrive: read absent, then present. Absent when the seat was
   *  already here — see the second line in the module header; its absence is why the trace can stay
   *  silent about length rather than inventing one. */
  arrivedAt?: number;
  /** When this client last read the seat present. The departure clock runs from here. Absent while
   *  the page has only ever read the seat offline, which is a record, not a visit. */
  lastOnlineAt?: number;
  /** Set once the seat has been read offline. Its presence is what makes a return a NEW visit. */
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
      if (before?.lastOnlineAt !== undefined && !before.departed) {
        // A visit we are already watching. The trace reports CONTIGUOUS presence only — stitching a
        // visit back across an observed absence would report one long stay where there were two
        // short ones, which is the most misleading thing this module could say, and the flicker case
        // is common (a wake that retries).
        next[seat.name] = { ...before, lastOnlineAt: now };
      } else if (before) {
        // We read this seat before and it was not here: an arrival, watched from this page. This is
        // the wake the rail exists for, and the only branch entitled to set `arrivedAt`.
        next[seat.name] = { arrivedAt: now, lastOnlineAt: now };
      } else {
        // The first time this page has read the seat at all, and it is already here. The visit began
        // before we were looking, so its length is not ours to state.
        next[seat.name] = { lastOnlineAt: now };
      }
      continue;
    }
    // Not here. Remember that, even for a seat we have never read online — that record is what makes
    // its next appearance a witnessed arrival rather than another unknown one. Nothing accumulates:
    // `next` is rebuilt from the roster on every fold, so the log is bounded by the size of the team,
    // and an expired trace stops rendering on its age (`dwellTrace`) rather than by being forgotten.
    next[seat.name] = before ? { ...before, departed: true } : { departed: true };
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
  // No visit, or a seat this page has only ever read offline: nothing was watched happening here,
  // and a row saying "was here" about a seat it never saw here is the lie this module is against.
  if (visit?.lastOnlineAt === undefined) return null;
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
