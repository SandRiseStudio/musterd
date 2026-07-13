import { useEffect, useState } from 'react';
import { formatClock } from './format';

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

  useEffect(() => {
    setNow(new Date());
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
  }, []);

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
