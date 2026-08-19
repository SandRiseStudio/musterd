import { useEffect, useState } from 'react';
import { formatClock } from './format';
import { stillMode } from './stillMode';

/**
 * The office clock. Wall time in the viewer's own zone (`9:27:11 AM PST`), ticking once a second.
 *
 * Each glyph owns a fixed-width slot and re-mounts (keyed by slot + character) when it changes, so a
 * changed digit rolls up through its slot while its neighbours sit still — the seconds column moves
 * every tick, the hour once an hour. SSR renders nothing and the first client tick fades in: the
 * server has no idea what zone the viewer is in, so there is no honest markup to hydrate.
 */
export function Clock() {
  const [now, setNow] = useState<Date | null>(null);

  const still = stillMode();
  useEffect(() => {
    setNow(new Date());
    // Measurement mode (ADR 285): one reading, no tick. The clock keeps showing a real time — it is
    // still measured, still contrast-checked, still exactly what a reader sees at any instant — it
    // just stops advancing while the page is being photographed.
    //
    // This is the single biggest reason connected /live never holds still. Measured 2026-08-19: the
    // route's longest quiet window across a 40s probe was 1029ms, and `lc-clock__digit` accounted
    // for 44 of the DOM changes past the 20s mark, because each glyph re-mounts (keyed by slot +
    // character) on every tick and the row's geometry shifts with it. /live passes today only
    // because the sweep's settle key set is class|ink|paper and therefore TEXT-BLIND, and because
    // its two geometry snapshots 250ms apart usually fall between ticks — a lucky sample, not a
    // settled page. contrast-sweep.mjs already carries a comment naming this hazard ("/live's asks
    // strip re-renders on a 1s setInterval, which no rAF freeze can stop because it is not on rAF");
    // the node-identity design there is a downstream patch for exactly this cause.
    if (still) return;
    // Re-align to the top of each wall-clock second rather than setInterval(1000), which drifts off
    // the second boundary and makes the seconds column stutter (skip/repeat) over a long session.
    let timer: number;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = window.setTimeout(tick, 1000 - (d.getTime() % 1000));
    };
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => window.clearTimeout(timer);
  }, [still]);

  if (!now) return null;
  const { time, meridiem, zone } = formatClock(now);

  return (
    <time className="lc-clock" dateTime={now.toISOString()} aria-label={`${time} ${meridiem} ${zone}`}>
      <span className="lc-clock__time" aria-hidden="true">
        {time.split('').map((ch, i) =>
          ch === ':' ? (
            <span key={`c${i}`} className="lc-clock__colon">
              :
            </span>
          ) : (
            <span key={`${i}:${ch}`} className="lc-clock__digit">
              {ch}
            </span>
          ),
        )}
      </span>
      <span className="lc-clock__zone" aria-hidden="true">
        {meridiem} {zone}
      </span>
    </time>
  );
}
