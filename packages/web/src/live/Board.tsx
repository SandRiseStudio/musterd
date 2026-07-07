import type { Lane, LaneState, LaneWarning } from '@musterd/protocol';
import { useMemo } from 'react';
import { initial, memberColor } from './format';

/**
 * The work board (ADR 104 increment 1): the team's lanes as a read-only kanban, one column per lane
 * state. Lane state *is* the column — the board renders what the daemon derives (no stored columns, no
 * CRUD). `abandoned` lanes are dropped from the board (not a column); everything else maps 1:1.
 */
const COLUMNS: ReadonlyArray<{ key: LaneState; label: string; tone: string }> = [
  { key: 'open', label: 'Backlog', tone: 'neutral' },
  { key: 'claimed', label: 'Claimed', tone: 'lane' },
  { key: 'active', label: 'In progress', tone: 'lane' },
  { key: 'blocked', label: 'Blocked', tone: 'danger' },
  { key: 'done', label: 'Done', tone: 'success' },
];

/** Compact relative age (`3m`, `2h`, `4d`) from a ms-epoch ts — how long a card has sat where it is. */
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function Board({ lanes, warnings }: { lanes: Lane[]; warnings: LaneWarning[] }) {
  // Lanes carrying a live warning (unmet dependency / surface overlap) — advisory, warn-never-block.
  const warned = useMemo(() => new Set(warnings.map((w) => w.subject)), [warnings]);
  const byState = useMemo(() => {
    const m = new Map<LaneState, Lane[]>(COLUMNS.map((c) => [c.key, []]));
    for (const lane of lanes) m.get(lane.state)?.push(lane); // abandoned has no column → excluded
    return m;
  }, [lanes]);

  return (
    <div className="lc-board">
      {COLUMNS.map((col) => {
        const items = byState.get(col.key) ?? [];
        return (
          <section key={col.key} className={`lc-col lc-col--${col.tone}`}>
            <header className="lc-col__head">
              <span className="lc-col__label">{col.label}</span>
              <span className="lc-col__count">{items.length}</span>
            </header>
            <div className="lc-col__cards">
              {items.length === 0 ? (
                <p className="lc-col__empty" aria-hidden="true">
                  —
                </p>
              ) : (
                items.map((lane) => (
                  <LaneCard key={lane.id} lane={lane} warned={warned.has(lane.id)} />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function LaneCard({ lane, warned }: { lane: Lane; warned: boolean }) {
  // Done cards age from resolved_at; live cards from claimed_at (how long in flight), else created.
  const stamp = lane.state === 'done' ? (lane.resolved_at ?? lane.updated_at) : (lane.claimed_at ?? lane.updated_at);
  return (
    <article className={`lc-card${warned ? ' lc-card--warned' : ''}`}>
      <p className="lc-card__title">{lane.title}</p>
      <div className="lc-card__meta">
        {lane.owner_seat && (
          <span className="lc-card__owner">
            <span
              className="lc-card__avatar"
              style={{ background: memberColor(lane.owner_seat, 'agent') }}
            >
              {initial(lane.owner_seat)}
            </span>
            {lane.owner_seat}
          </span>
        )}
        {lane.goal_id && <span className="lc-card__chip lc-card__chip--goal">{lane.goal_id}</span>}
        {lane.branch && <span className="lc-card__chip lc-card__chip--branch">{lane.branch}</span>}
      </div>
      <div className="lc-card__foot">
        {warned && (
          <span className="lc-card__warn" title="Has a lane warning — dependency or surface overlap">
            ⚠ flag
          </span>
        )}
        <time className="lc-card__age">{ago(stamp)}</time>
      </div>
    </article>
  );
}
