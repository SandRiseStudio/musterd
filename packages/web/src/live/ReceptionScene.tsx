import type { CSSProperties } from 'react';
import './ReceptionScene.css';

/**
 * The office's front desk, in miniature — a flat SVG companion piece to the approval queue below it
 * (ADR 098). Not the isometric canvas (office-scene/): a page banner doesn't need the full actor/pose
 * engine, just a reactive read of how many harnesses are waiting at the door. Visitor chips are
 * count-driven, not per-identity — the queue reflows on every poll without needing enter/exit
 * transitions keyed to a specific request id.
 */
const MAX_VISIBLE = 5;
/** Alternate two office identity hues (ADR 036) so the queue doesn't read as one flat color. */
const HUES = ['var(--lc-agent)', 'var(--lc-human)'];

export function ReceptionScene({ count }: { count: number }) {
  const visible = Math.min(count, MAX_VISIBLE);
  const overflow = count - visible;

  return (
    <div className={`lc-reception${count === 0 ? ' is-empty' : ''}`}>
      <svg className="lc-reception__door" viewBox="0 0 64 96" aria-hidden="true">
        <rect x="2" y="2" width="60" height="92" rx="3" fill="var(--wood, #7a4e2d)" />
        <rect x="6" y="6" width="24" height="84" rx="2" fill="var(--lc-surface-2)" />
        <rect x="34" y="6" width="24" height="84" rx="2" fill="var(--lc-surface-2)" />
        <rect x="26" y="44" width="1.5" height="8" fill="var(--lc-faint)" />
        <rect x="36.5" y="44" width="1.5" height="8" fill="var(--lc-faint)" />
      </svg>

      <div className="lc-reception__queue">
        {count === 0 ? (
          <p className="lc-reception__quiet">The front desk is quiet — no one's waiting.</p>
        ) : (
          <>
            <div className="lc-reception__chips">
              {Array.from({ length: visible }, (_, i) => (
                <span
                  key={i}
                  className="lc-reception__chip"
                  style={{ '--lc-chip-hue': HUES[i % HUES.length], animationDelay: `${i * 180}ms` } as CSSProperties}
                  aria-hidden="true"
                >
                  <span className="lc-reception__chip-ring" />
                </span>
              ))}
              {overflow > 0 && <span className="lc-reception__more">+{overflow} more</span>}
            </div>
            <p className="lc-reception__caption">
              {count} {count === 1 ? 'request' : 'requests'} waiting at the door
            </p>
          </>
        )}
      </div>
    </div>
  );
}
