import type { MemberSummary } from '@musterd/protocol';
import { memberColor, memberPosture, rosterOrder } from './format';

/**
 * The office noticeboard — the roster as a physical object in the office panel, with names.
 *
 * **Why it is not on a wall.** It was, and the wall cannot hold it. `fitFloor` is width-limited in the
 * office column at every realistic window size, and measured on /live at a 1280px viewport the whole
 * back wall came to **63px tall** — 5.3px per seat across a 12-seat team, where a legible name needs
 * about 12. Widening the column (#529) buys a 76px wall; removing all four windows buys only *width*,
 * and the shortage is height. A wall in a 2:1 iso room is simply not a surface that twelve names fit on.
 *
 * So the board comes off the wall and hangs in the strip the reshape reclaimed underneath the room —
 * space the panel used to letterbox away. Off the wall it is free of the scene's scale entirely: the
 * type is DOM at a fixed size, so it reads the same on a laptop as on the 1920×1080 broadcast, which is
 * the one thing a canvas-painted board could never promise.
 *
 * It is still an *object*, not a data table: cork, a wooden frame, and one pinned slip per member in
 * their own colour — the same colour their avatar and floating nameplate already wear. The colour-tag
 * pin board that briefly lived on the wall is what this replaces.
 */
export function OfficeBoard({ roster }: { roster: MemberSummary[] }) {
  const members = [...roster].sort(rosterOrder);
  const present = members.filter((m) => {
    const p = memberPosture(m);
    return p === 'working' || p === 'idle';
  }).length;

  return (
    <aside className="lc-notice" aria-label="Office noticeboard — who is in">
      <div className="lc-notice__frame">
        <div className="lc-notice__head">
          <span className="lc-notice__title">WHO&rsquo;S IN</span>
          <span className="lc-notice__count">
            <strong>{present}</strong>
            <span className="lc-notice__of">/{members.length}</span>
          </span>
        </div>
        <ul className="lc-notice__slips">
          {members.map((m) => {
            const posture = memberPosture(m);
            const out = posture === 'away' || posture === 'offline';
            return (
              <li
                key={m.name}
                className={`lc-notice__slip lc-notice__slip--${posture}${out ? ' is-out' : ''}`}
                style={{ '--slip-tone': memberColor(m.name, m.kind) } as React.CSSProperties}
              >
                <span className="lc-notice__pin" aria-hidden="true" />
                <span className="lc-notice__dot" aria-hidden="true" />
                <span className="lc-notice__name">{m.name}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
