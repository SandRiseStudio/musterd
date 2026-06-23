import type { CSSProperties } from 'react';
import { CATEGORY_META, CATEGORY_ORDER, STATUS_META, STATUS_ORDER } from '../../content/roadmap.data';
import { WindingRoad } from './WindingRoad';
import './Roadmap.css';

export function Roadmap() {
  return (
    <section className="roadmap" id="roadmap">
      <div className="roadmap__head shell">
        <p className="roadmap__eyebrow mono">the map</p>
        <h2 className="roadmap__title">Where musterd has been, is, and is going</h2>
        <p className="roadmap__lede">
          A winding road from what is laid down, through the active frontier, into the reserved road
          ahead — with the lines that connect what builds on what.
        </p>
        <Legend />
        <CategoryKey />
      </div>

      <div className="roadmap__map shell">
        <WindingRoad />
      </div>
    </section>
  );
}

function CategoryKey() {
  return (
    <div className="catkey" aria-label="Category key">
      {CATEGORY_ORDER.map((c) => {
        const meta = CATEGORY_META[c];
        return (
          <span className="catkey__item" key={c} style={{ '--cat': meta.color } as CSSProperties}>
            <span className="catkey__dot" aria-hidden="true" />
            {meta.short}
          </span>
        );
      })}
    </div>
  );
}

function Legend() {
  return (
    <div className="legend" role="list" aria-label="Status legend">
      {STATUS_ORDER.map((status) => {
        const meta = STATUS_META[status];
        return (
          <div className="legend__item" role="listitem" key={status} data-status={status}>
            <span className="legend__dot" aria-hidden="true" />
            <span className="legend__label">{meta.label}</span>
            <span className="legend__tone">{meta.tone}</span>
          </div>
        );
      })}
    </div>
  );
}
