import type { Envelope, LaneBoard, MemberSummary, WorkingHours } from '@musterd/protocol';
import type { ConnStatus } from './client';
import type { RoomEntry } from './workingOn';

/**
 * The room's own facts — what the office *is*, as opposed to how a given surface frames it.
 *
 * `/live` and `/broadcast` are two windows onto one room, and the difference between them is meant to
 * be chrome: the page has panels, a roster rail and things you can click; the stream is full-bleed and
 * answers nothing. What the room *contains* is not a difference, and every fact reaching both surfaces
 * is not a courtesy — a fact that renders on the page and not on the stream is a bug that the stream,
 * by construction, cannot report. The working-hours calendar shipped exactly that way: wired on
 * `/live`, never passed on `/broadcast`, and invisible to every test because both routes typechecked
 * (nick, 2026-08-03: "live and broadcast should always be in sync").
 *
 * So the room is one object, built once by `officeRoom` and spread by both routes. Adding a fact here
 * is a type error at the builder until it is supplied — and then both surfaces have it. Chrome props
 * (`collapsed`, `topSlot`, `broadcast`, `onReady`, …) stay per-surface and out of this type; they are
 * the part that is genuinely allowed to differ.
 */
export interface OfficeRoomProps {
  teamName: string;
  teamWorkingHours: WorkingHours | null;
  roster: MemberSummary[];
  envelopes: Envelope[];
  liveIds: Set<string>;
  entries: RoomEntry[];
  board: LaneBoard | null;
  status: ConnStatus;
}

/** What a route already holds after `useLiveStream` — named structurally so this module owes the hook
 *  nothing but the fields it reads. */
export interface RoomStream {
  teamWorkingHours: WorkingHours | null;
  roster: MemberSummary[];
  envelopes: Envelope[];
  liveIds: Set<string>;
  status: ConnStatus;
}

/**
 * Assemble the room from a route's stream plus the two projections routes derive themselves (the
 * overlay's reel and the lane board). Every caller gets the same room; what they wrap it in is theirs.
 */
export function officeRoom(
  teamName: string,
  stream: RoomStream,
  derived: { entries: RoomEntry[]; board: LaneBoard | null },
): OfficeRoomProps {
  return {
    teamName,
    teamWorkingHours: stream.teamWorkingHours,
    roster: stream.roster,
    envelopes: stream.envelopes,
    liveIds: stream.liveIds,
    entries: derived.entries,
    board: derived.board,
    status: stream.status,
  };
}
