import type { Envelope, LaneBoard } from '@musterd/protocol';
import { useEffect, useRef, useState } from 'react';
import { fetchLaneBoard, type LiveConfig } from './client';
import { invalidatesLanes } from './workingOn';

/**
 * The lane board behind the overlay's working-on strap.
 *
 * **No polling.** One fetch when the connection comes up, then a re-fetch only when a lane act
 * arrives on the firehose we are already subscribed to. Lane changes are rare and self-announcing, so
 * idle cost is effectively zero — the ADR 151 contract every /live viewer pays into forever.
 *
 * A failed fetch keeps the previous board (a stale strap beats a flashing one) and is otherwise
 * silent: this is ambient chrome, never an error surface. On a stream there is nobody to tell.
 */
export function useWorkingOn(cfg: LiveConfig | null, envelopes: Envelope[]): LaneBoard | null {
  const [board, setBoard] = useState<LaneBoard | null>(null);
  // The newest envelope we have already reacted to — so a re-render never re-fetches.
  const seenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cfg) {
      setBoard(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchLaneBoard(cfg);
        if (!cancelled) setBoard(next);
      } catch {
        /* keep the previous board */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg]);

  useEffect(() => {
    if (!cfg || envelopes.length === 0) return;
    // `envelopes` is sorted oldest-first by useLiveStream, so the newest arrival is the last element.
    const latest = envelopes[envelopes.length - 1]!;
    if (latest.id === seenRef.current) return;
    seenRef.current = latest.id;
    if (!invalidatesLanes(latest)) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchLaneBoard(cfg);
        if (!cancelled) setBoard(next);
      } catch {
        /* keep the previous board */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg, envelopes]);

  return board;
}
