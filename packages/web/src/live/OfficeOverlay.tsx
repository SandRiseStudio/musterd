import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ConnStatus } from './client';
import type { RoomEntry } from './workingOn';

/**
 * The office's on-screen chrome — **the same component on `/live` and `/broadcast`**, rendered inside
 * `OfficeScene` so the dashboard and the stream cannot drift apart (nick's standing decision,
 * 2026-07-24).
 *
 * It answers one question — *who is in this room and what are they on* — as a **reel of members** you
 * can steer, one per line, in a contained lower-third card.
 *
 * ## The two things this went through, and why it landed here
 *
 * It began as a full-bleed scrim with one line per lane, which ate the bottom fifth of the room for
 * four lines of text. It became this card, which auto-cycled. Both were **broadcast chrome pointed at
 * a dashboard user** — the first spent the room's pixels, the second spent the viewer's patience
 * (nick, 2026-07-28: "it's like an auto advancing carousel"). So:
 *
 * · **On `/live` the reel is a control.** Wheel over it, press ← / →, or click the chevrons — the
 *   auto-advance yields the moment you touch it and resumes once you have been still a while. A
 *   watcher looking for one teammate should never have to wait for the carousel to come back around.
 * · **On `/broadcast` it stays a chyron.** A stream has no cursor: `interactive` is false there, and
 *   the component keeps exactly its passive behaviour — non-interactive, hidden from assistive tech,
 *   cycling on its own.
 *
 * The rail along the bottom edge is the honesty in both modes: how many members there are, which one
 * you are on, and — while auto-advance is running — when the next arrives.
 */

/** How long one member holds the card. The rail's sweep is driven from this same number, so the bar
 *  finishing and the reel advancing are the same event rather than two that drift apart. */
const DWELL_MS = 6000;

/** How long the reel stays where you put it after a manual step, before auto-advance takes over
 *  again. Long enough to read a title and look at that person on the floor, short enough that a
 *  dashboard left alone goes back to telling you things. */
const STEERED_MS = 20000;

/** Wheel delta to accumulate before stepping — a trackpad emits many small deltas per flick, and
 *  stepping per event would fly through the whole roster on one gesture. */
const WHEEL_STEP = 42;

export function OfficeOverlay({
  teamName,
  present,
  entries,
  status,
  interactive = false,
}: {
  teamName: string;
  present: number;
  entries: RoomEntry[];
  status: ConnStatus;
  /** `/live` only. False keeps the passive, non-interactive, aria-hidden chyron `/broadcast` needs. */
  interactive?: boolean;
}) {
  const live = status === 'live';
  const count = entries.length;
  const signature = entries.map((e) => e.name).join(',');

  const [index, setIndex] = useState(0);
  // `null` = running. A timestamp = the reel is held where the viewer put it, until it expires.
  const [steeredAt, setSteeredAt] = useState<number | null>(null);
  const [engaged, setEngaged] = useState(false); // pointer over, or focus within
  const wheelRef = useRef(0);

  // A changed roster restarts the reel at the top rather than stranding the viewer mid-list.
  useEffect(() => {
    setIndex(0);
  }, [signature]);

  const step = useCallback(
    (delta: number) => {
      if (count < 2) return;
      setIndex((n) => (n + delta + count) % count);
      setSteeredAt(Date.now());
    },
    [count],
  );

  const paused = !interactive ? false : engaged || steeredAt !== null;

  // Auto-advance. Off while the viewer is steering or hovering, and off on a hidden tab — a
  // background dashboard costs a viewer nothing, per the packages/web perf contract.
  useEffect(() => {
    if (count < 2 || paused) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      timer = setTimeout(() => {
        setIndex((n) => (n + 1) % count);
        arm();
      }, DWELL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else if (!timer) {
        arm();
      }
    };
    if (!document.hidden) arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [count, paused, signature]);

  // Hand the reel back after the viewer has been still. Hovering holds it indefinitely — the clock
  // only starts once the pointer leaves, which is what "I am reading this" actually looks like.
  useEffect(() => {
    if (steeredAt === null || engaged) return;
    const t = setTimeout(() => setSteeredAt(null), STEERED_MS);
    return () => clearTimeout(t);
  }, [steeredAt, engaged]);

  const onWheel = (e: React.WheelEvent) => {
    if (!interactive || count < 2) return;
    // Trackpads report horizontal intent too; a reel is a horizontal thing, so honour both axes.
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    wheelRef.current += d;
    while (Math.abs(wheelRef.current) >= WHEEL_STEP) {
      step(wheelRef.current > 0 ? 1 : -1);
      wheelRef.current -= Math.sign(wheelRef.current) * WHEEL_STEP;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Home') {
      setIndex(0);
      setSteeredAt(Date.now());
    } else return;
    e.preventDefault();
  };

  const entry = entries[Math.min(index, Math.max(count - 1, 0))];

  return (
    <div
      className={`lc-ov${interactive ? ' is-interactive' : ''}`}
      // Operable means readable: the passive chyron stays hidden from assistive tech (every fact is
      // in the roster rail in accessible form), but a thing with buttons must not be.
      aria-hidden={interactive ? undefined : true}
    >
      <div
        className="lc-ov__card"
        role={interactive ? 'group' : undefined}
        aria-label={interactive ? 'who is in the room, and what they are on' : undefined}
        tabIndex={interactive && count > 1 ? 0 : undefined}
        onWheel={interactive ? onWheel : undefined}
        onKeyDown={interactive ? onKeyDown : undefined}
        onPointerEnter={interactive ? () => setEngaged(true) : undefined}
        onPointerLeave={interactive ? () => setEngaged(false) : undefined}
        onFocus={interactive ? () => setEngaged(true) : undefined}
        onBlur={
          interactive ? (e) => setEngaged(e.currentTarget.contains(e.relatedTarget)) : undefined
        }
      >
        <div className="lc-ov__id">
          <span className="lc-ov__mark" />
          <span className="lc-ov__team">{teamName}</span>
          <span className={`lc-ov__sig${live ? ' is-live' : ''}`}>
            <i className="lc-ov__dot" />
            {live ? 'LIVE' : 'CONNECTING'}
          </span>

          {interactive && count > 1 ? (
            // The steering group replaces the passive headcount: on a surface you can drive, the
            // useful thing in this corner is where you are and how to move, not a number the roster
            // rail already carries.
            <span className="lc-ov__nav">
              <button
                type="button"
                className="lc-ov__step"
                onClick={() => step(-1)}
                aria-label="previous teammate"
              >
                ‹
              </button>
              <span className="lc-ov__count">
                {index + 1}
                <span className="lc-ov__count-of">/{count}</span>
              </span>
              <button
                type="button"
                className="lc-ov__step"
                onClick={() => step(1)}
                aria-label="next teammate"
              >
                ›
              </button>
            </span>
          ) : (
            live &&
            present > 0 && (
              <span className="lc-ov__present">
                {present} <span className="lc-ov__present-unit">in the room</span>
              </span>
            )
          )}
        </div>

        {entry ? (
          // Keyed by member, so React replaces the node and the entrance plays on every change of
          // subject — the lift-and-fade IS how you know the reel moved.
          <p
            key={entry.name}
            className={`lc-ov__now${entry.laneState === 'blocked' ? ' is-blocked' : ''}${
              entry.title === null ? ' is-quiet' : ''
            }`}
            style={{ '--lc-ov-seat': entry.color } as CSSProperties}
          >
            <span className="lc-ov__who">
              <i className="lc-ov__seat" />
              {entry.name}
            </span>
            {entry.laneState === 'blocked' && <span className="lc-ov__flag">blocked</span>}
            <span className="lc-ov__title">
              {entry.title ?? (entry.posture === 'away' ? 'away from the desk' : 'nothing claimed')}
            </span>
            {/* A self-reported line is not a claimed lane. Mark the difference rather than let the
                card imply work is owned when it is only announced. */}
            {entry.source === 'status' && <span className="lc-ov__src">said</span>}
            {entry.moreLanes > 0 && <span className="lc-ov__more">+{entry.moreLanes}</span>}
          </p>
        ) : (
          <p className="lc-ov__now is-quiet">
            <span className="lc-ov__title">nobody in the room yet</span>
          </p>
        )}

        {/* One segment per member, the live one sweeping out its dwell while auto-advance runs. Below
            two there is no reel, so there is nothing to report and the rail stays off. */}
        {count > 1 && (
          <span className={`lc-ov__rail${paused ? ' is-paused' : ''}`}>
            {entries.map((e, i) => (
              <i
                key={e.name}
                className={`lc-ov__seg${i === index ? ' is-live' : ''}${i < index ? ' is-past' : ''}`}
              >
                {/* Keyed by `index`, not by member: the segment persists across steps, so only a
                    fresh node restarts the sweep from zero. */}
                <i
                  key={index}
                  className="lc-ov__fill"
                  style={{ animationDuration: `${DWELL_MS}ms` }}
                />
              </i>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
