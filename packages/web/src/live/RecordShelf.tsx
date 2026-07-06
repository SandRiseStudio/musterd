import './RecordShelf.css';

/**
 * A flat SVG bookshelf — the office's record wall (ADR 098) framing the governance audit log as the
 * team's permanent shelf of decisions, mirroring the isometric bookshelf's book-spine motif
 * (office-scene/render.ts `bookshelf()`) without pulling in the canvas renderer for one static banner.
 */
const SPINES = ['#c95c4a', '#e0a72b', '#5aa0c9', '#6aa86a', '#b06fc9', '#d98b4a', '#5aa0c9', '#c95c4a'];

export function RecordShelf() {
  return (
    <div className="lc-shelf">
      <svg className="lc-shelf__art" viewBox="0 0 120 64" aria-hidden="true">
        <rect x="1" y="1" width="118" height="62" rx="3" fill="var(--wood, #7a4e2d)" />
        <rect x="6" y="6" width="108" height="16" rx="1.5" fill="var(--lc-ground-2)" />
        <rect x="6" y="24" width="108" height="16" rx="1.5" fill="var(--lc-ground-2)" />
        <rect x="6" y="42" width="108" height="16" rx="1.5" fill="var(--lc-ground-2)" />
        {SPINES.map((c, i) => (
          <rect key={`r0-${i}`} x={10 + i * 13} y="7" width="9" height="14" rx="1" fill={c} />
        ))}
        {SPINES.map((c, i) => (
          <rect key={`r1-${i}`} x={10 + i * 13} y="25" width="9" height="14" rx="1" fill={SPINES[(i + 3) % SPINES.length]} />
        ))}
        {SPINES.map((c, i) => (
          <rect key={`r2-${i}`} x={10 + i * 13} y="43" width="9" height="14" rx="1" fill={SPINES[(i + 5) % SPINES.length]} />
        ))}
        {/* the one open record — a bright accent spine, slightly raised */}
        <rect x="49" y="41" width="9" height="16" rx="1" fill="var(--lc-accent-bright)" />
      </svg>
      <p className="lc-shelf__caption">The office's record book — every governance decision, permanently logged.</p>
    </div>
  );
}
