import type { CSSProperties } from 'react';
import {
  CATEGORY_META,
  ROADMAP,
  STATUS_META,
  STATUS_ORDER,
  type RoadmapItem,
  type Status,
} from '../../content/roadmap.data';
import { useReveal } from '../useReveal';
import './Roadmap.css';

export function Roadmap() {
  return (
    <section className="roadmap shell" id="roadmap">
      <Legend />
      <div className="roadmap__groups">
        {STATUS_ORDER.map((status) => (
          <StatusGroup key={status} status={status} />
        ))}
      </div>
    </section>
  );
}

function Legend() {
  return (
    <div className="legend" role="list" aria-label="Status legend">
      {STATUS_ORDER.map((status) => {
        const meta = STATUS_META[status];
        return (
          <div className="legend__item" role="listitem" key={status}>
            <span className="legend__dot" style={{ background: `var(${meta.cssVar})` }} aria-hidden="true" />
            <span className="legend__label">{meta.label}</span>
            <span className="legend__tone">{meta.tone}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatusGroup({ status }: { status: Status }) {
  const items = ROADMAP.filter((i) => i.status === status);
  const meta = STATUS_META[status];

  return (
    <div className="group" data-status={status}>
      <div className="group__head">
        <span className="group__dot" style={{ background: `var(${meta.cssVar})` }} aria-hidden="true" />
        <h2 className="group__title">{meta.label}</h2>
        <span className="group__count mono">{String(items.length).padStart(2, '0')}</span>
      </div>
      <div className="group__items">
        {items.map((item, i) => (
          <Card key={item.id} item={item} index={i} />
        ))}
      </div>
    </div>
  );
}

function Card({ item, index }: { item: RoadmapItem; index: number }) {
  const ref = useReveal<HTMLElement>();
  return (
    <article
      ref={ref}
      className="card"
      data-reveal="out"
      data-status={item.status}
      style={{ '--i': index } as CSSProperties}
    >
      <div className="card__top">
        <span className="card__category mono">{CATEGORY_META[item.category].label}</span>
      </div>
      <h3 className="card__title">{item.title}</h3>
      <p className="card__blurb">{item.blurb}</p>
      {item.detail ? (
        <div className="card__detail">
          <p>{item.detail}</p>
        </div>
      ) : null}
      {item.refs?.length ? (
        <div className="card__refs">
          {item.refs.map((ref) => (
            <a key={ref.label} className="card__ref mono" href={ref.href} target="_blank" rel="noreferrer">
              {ref.label}
            </a>
          ))}
        </div>
      ) : null}
    </article>
  );
}
