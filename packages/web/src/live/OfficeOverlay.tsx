import type { ConnStatus } from './client';
import type { WorkingOnEntry } from './workingOn';

/**
 * The office's on-screen chrome — **the same component on `/live` and `/broadcast`**, rendered inside
 * `OfficeScene` so the dashboard and the stream cannot drift apart (nick's standing decision,
 * 2026-07-24).
 *
 * It carries **orientation, not narration**: who this team is, who is in the room, and what they are
 * working on. Acts stay with the speech bubbles. That division matters because the office rests on a
 * still frame between ambient beats — a viewer landing on a motionless room still learns something
 * here, where an act ticker would be blank.
 *
 * The strap is a **lane stack**, not a row of chips: a mono seat tag against a display-face title,
 * one lane per line. That is musterd's own vocabulary on screen — a lane is owned by exactly one
 * seat — and it reads at a glance on a phone-sized stream, which a wrapping chip row does not.
 *
 * Never interactive (`pointer-events: none`), and hidden from assistive tech: every fact it shows is
 * also in the roster rail and the stream, in accessible form.
 */
export function OfficeOverlay({
  teamName,
  present,
  lanes,
  status,
}: {
  teamName: string;
  present: number;
  lanes: WorkingOnEntry[];
  status: ConnStatus;
}) {
  const live = status === 'live';
  return (
    <div className="lc-ov" aria-hidden="true">
      {/* The padded box is a child of the container, never the container itself: `cq` units cannot
          resolve against the element that declares them. */}
      <div className="lc-ov__inner">
        <div className="lc-ov__id">
          <span className="lc-ov__mark" />
          <span className="lc-ov__team">{teamName}</span>
          <span className={`lc-ov__sig${live ? ' is-live' : ''}`}>
            <i className="lc-ov__dot" />
            {live ? 'LIVE' : 'CONNECTING'}
          </span>
          {live && present > 0 && (
            <span className="lc-ov__present">
              {present} <span className="lc-ov__present-unit">in the room</span>
            </span>
          )}
        </div>

        {lanes.length > 0 && (
          <ul className="lc-ov__strap">
            {lanes.map((l, i) => (
              // `key` is the lane id, so React reuses the node across refreshes and only genuinely
              // new lanes play the enter animation. Keying by index would replay it on every fetch.
              //
              // `is-fresh` marks index 0 — `workingOn` sorts by recency, so the top line is the lane
              // that moved most recently. The accent is information, not decoration: it is the one
              // place the overlay spends colour, and it points at what just changed.
              <li
                key={l.id}
                className={`lc-ov__lane${i === 0 ? ' is-fresh' : ''}${
                  l.state === 'blocked' ? ' is-blocked' : ''
                }`}
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <span className="lc-ov__owner">{l.owner}</span>
                <span className="lc-ov__title">{l.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
