import type { LaneBoard, MemberSummary, OpenLane, UpdateLane } from '@musterd/protocol';
import { useCallback, useEffect, useState } from 'react';
import { createLane, updateLane, type LiveConfig } from './client';
import { applyLaneEcho } from './boardWrite';

/** The one polite status line for write outcomes ("lane opened", "handed to izzo", errors). */
export interface BoardNote {
  tone: 'ok' | 'err';
  text: string;
}

/**
 * The board's data half, shared between the standalone `/board` page and the office overlay on
 * `/live`. The caller supplies `base` — its own `useWorkingOn` result — so a host that already
 * holds the lane board (as `/live` does) never fetches it twice.
 *
 * Optimistic overlay: our own writes fold in from the daemon's echo (the firehose skips the sender,
 * so the echo is the only copy we see). Any fresh base fetch is daemon truth and supersedes it —
 * base identity is the reset trigger.
 */
export function useBoardData(
  cfg: LiveConfig | null,
  roster: MemberSummary[],
  base: LaneBoard | null,
) {
  const [note, setNote] = useState<BoardNote | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // A note narrates writes made over ONE connection; switching identity or team orphans it.
  useEffect(() => setNote(null), [cfg]);

  const [optimistic, setOptimistic] = useState<LaneBoard | null>(null);
  useEffect(() => setOptimistic(null), [base]);
  const board = optimistic ?? base;

  // The write gate, verbatim from AsksStrip (ADR 149): the auto-provisioned observer is hidden from
  // the roster, so membership is exactly "connected as a real seat".
  const me = cfg != null && roster.some((m) => m.name === cfg.as) ? cfg.as : null;

  const doCreate = useCallback(
    async (input: OpenLane): Promise<boolean> => {
      if (!cfg) return false;
      setBusyId('compose');
      setNote(null);
      try {
        const result = await createLane(cfg, input);
        setOptimistic((prev) => applyLaneEcho(prev ?? base ?? { lanes: [], warnings: [] }, result));
        setNote({ tone: 'ok', text: `lane opened — "${result.lane.title}"` });
        return true;
      } catch (e) {
        setNote({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [cfg, base],
  );

  const doPatch = useCallback(
    async (id: string, patch: UpdateLane): Promise<boolean> => {
      if (!cfg) return false;
      setBusyId(id);
      setNote(null);
      try {
        const result = await updateLane(cfg, id, patch);
        setOptimistic((prev) => applyLaneEcho(prev ?? base ?? { lanes: [], warnings: [] }, result));
        setNote({ tone: 'ok', text: noteFor(patch, result.lane.title, cfg.as) });
        return true;
      } catch (e) {
        setNote({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [cfg, base],
  );

  const clearNote = useCallback(() => setNote(null), []);

  return { board, me, busyId, note, clearNote, doCreate, doPatch };
}

/** The status line's phrasing per verb — same vocabulary as the pills, in the room's voice. */
function noteFor(patch: UpdateLane, title: string, meName: string): string {
  if (patch.owner_seat === meName) return `claimed — "${title}"`;
  if (patch.owner_seat) return `handed to ${patch.owner_seat} — they'll see it`;
  switch (patch.state) {
    case 'active':
      return `in flight — "${title}"`;
    case 'blocked':
      return `marked stuck — "${title}"`;
    case 'done':
      return `done — "${title}" shipped`;
    case 'abandoned':
      return 'let it go.';
    default:
      return 'updated';
  }
}
