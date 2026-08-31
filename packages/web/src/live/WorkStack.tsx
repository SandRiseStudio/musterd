import type { RoomEntry } from './workingOn';
import { shortLaneState } from './presenceLabel';

/**
 * Who is working — floats over the office floor (presence-chrome design). Present members with a
 * title only; no full roster, no carousel. Rendered inside `OfficeScene` as stage chrome.
 *
 * The header also carries the room's narration line (first-five-seconds §2) when one is live —
 * it replaced a floating lower-third element over the scene (nick, 2026-08-31): a transient
 * sentence is chrome, and chrome belongs in the frame, not on the floor.
 */
export function WorkStack({ entries, caption }: { entries: RoomEntry[]; caption?: string | null }) {
  const rows = entries.filter((e) => e.title != null);
  const narration = (
    <span className="lc-workstack__caption" aria-live="polite">
      {caption ?? ''}
    </span>
  );
  if (rows.length === 0) {
    return (
      <aside className="lc-workstack" aria-label="Who is working">
        <div className="lc-workstack__frame">
          <header className="lc-workstack__head">
            <span className="lc-workstack__mark" aria-hidden="true" />
            <span className="lc-workstack__title-label">on the floor</span>
            {narration}
            <span className="lc-workstack__quiet">nobody claimed yet</span>
          </header>
        </div>
      </aside>
    );
  }
  return (
    <aside className="lc-workstack" aria-label="Who is working">
      <div className="lc-workstack__frame">
        <header className="lc-workstack__head">
          <span className="lc-workstack__mark" aria-hidden="true" />
          <span className="lc-workstack__title-label">on the floor</span>
          {narration}
          <span className="lc-workstack__count">
            {rows.length} working
          </span>
        </header>
        <ul className="lc-workstack__list">
          {rows.map((e) => {
            const chip = shortLaneState(e.laneState);
            return (
              <li
                key={e.name}
                className={`lc-workstack__row${chip === 'blocked' ? ' is-blocked' : ''}`}
              >
                <i
                  className="lc-workstack__dot"
                  style={{ background: e.color }}
                  aria-hidden="true"
                />
                <span className="lc-workstack__name">{e.name}</span>
                <span className="lc-workstack__task" title={e.title ?? undefined}>
                  {e.title}
                </span>
                {chip && <span className="lc-workstack__state">{chip}</span>}
                {e.source === 'status' && <span className="lc-workstack__said">said</span>}
                {e.moreLanes > 0 && (
                  <span className="lc-workstack__more">+{e.moreLanes}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
