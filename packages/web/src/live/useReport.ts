import type { Envelope, Report } from '@musterd/protocol';
import { useEffect, useRef, useState } from 'react';
import { fetchReport, type LiveConfig } from './client';
import { invalidatesLanes } from './workingOn';

/**
 * The insight report behind the board's rail — the useWorkingOn pattern, verbatim (Inc B).
 *
 * **No polling.** One fetch when the connection comes up, then a re-fetch only when a lane act
 * arrives on the firehose we already subscribe to — the report is lane-derived at its core (flow,
 * blocked, goal status), so lane events are the honest trigger. A failed fetch keeps the previous
 * report and stays silent: the rail is ambient chrome, never an error surface.
 */
export function useReport(cfg: LiveConfig | null, envelopes: Envelope[]): Report | null {
  const [report, setReport] = useState<Report | null>(null);
  const seenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cfg) {
      setReport(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchReport(cfg);
        if (!cancelled) setReport(next);
      } catch {
        /* keep the previous report */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg]);

  useEffect(() => {
    if (!cfg || envelopes.length === 0) return;
    const latest = envelopes[envelopes.length - 1]!;
    if (latest.id === seenRef.current) return;
    seenRef.current = latest.id;
    if (!invalidatesLanes(latest)) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchReport(cfg);
        if (!cancelled) setReport(next);
      } catch {
        /* keep the previous report */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg, envelopes]);

  return report;
}
