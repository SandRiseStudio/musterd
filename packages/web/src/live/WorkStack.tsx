import type { RoomEntry } from './workingOn';
import { shortLaneState, truncateWork } from './presenceLabel';

/**
 * Fallback A — in-panel list of present members who have something on (presence-chrome design
 * 2026-07-30 §2). Used when hybrid nameplate work cues clutter the floor (`workCues === 'stack'`).
 */
export function WorkStack({ entries }: { entries: RoomEntry[] }) {
  const rows = entries.filter((e) => e.title != null);
  if (rows.length === 0) return null;
  return (
    <aside className="lc-workstack" aria-label="Who is working">
      <ul className="lc-workstack__list">
        {rows.map((e) => {
          const chip = shortLaneState(e.laneState);
          return (
            <li key={e.name} className="lc-workstack__row">
              <i className="lc-workstack__dot" style={{ background: e.color }} aria-hidden="true" />
              <span className="lc-workstack__name">{e.name}</span>
              <span className="lc-workstack__title">{truncateWork(e.title!, 40)}</span>
              {chip && <span className="lc-workstack__state">{chip}</span>}
              {e.source === 'status' && <span className="lc-workstack__said">said</span>}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
