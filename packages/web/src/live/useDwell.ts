import { useEffect, useState } from 'react';
import { DWELL_WINDOW_MS, observeSeats, type DwellLog, type DwellSeat } from './dwell';

/** How often a live trace re-renders. One second, because the trace counts in seconds. */
const TICK_MS = 1_000;

/**
 * Keep the dwell log for the seats on screen, and tick a clock only while a trace is actually live.
 *
 * The tick is conditional on purpose. /live runs a 30fps office scene and a broadcast capture beside
 * this rail, and a permanent one-second re-render of the roster to animate text that is usually
 * absent is exactly the kind of always-on cost the scene chrome rules exist to refuse. `hasTrace`
 * is false in the ordinary case — nobody has left in the last ninety seconds — and then this hook
 * schedules nothing at all.
 *
 * All state derives from roster reads, which `useLiveStream` refetches on every presence change, so
 * a wake's attach and detach both land here as reads rather than as anything this module infers.
 */
export function useDwell(roster: readonly DwellSeat[]): { log: DwellLog; now: number } {
  const [log, setLog] = useState<DwellLog>({});
  const [now, setNow] = useState(() => Date.now());

  // Folded with the functional form on purpose: the previous log must not be a dependency of the
  // effect that produces the next one — every fold returns a fresh object, so depending on it would
  // re-run the effect forever. This is also why `now` is captured once per fold rather than read
  // inside it: one read, one clock, for every seat in the same roster read.
  useEffect(() => {
    const at = Date.now();
    setLog((prev) => observeSeats(prev, roster, at));
    setNow(at);
  }, [roster]);

  // A record with no `lastOnlineAt` is a seat this page has only ever read absent — remembered so its
  // next arrival counts as witnessed, but never a trace, and so never a reason to run the tick.
  const hasTrace = Object.values(log).some(
    (v) =>
      v.departed === true && v.lastOnlineAt !== undefined && now - v.lastOnlineAt <= DWELL_WINDOW_MS,
  );

  useEffect(() => {
    if (!hasTrace) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [hasTrace]);

  return { log, now };
}
