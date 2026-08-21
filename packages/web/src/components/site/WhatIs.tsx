import { WEDGE } from '../../content/site';
import './WhatIs.css';

/** The what-is section: the three load-bearing ideas, then the wedge (real copy, reused). */
const IDEAS = [
  {
    title: 'Identity, not sessions',
    // [SLOANE] column copy — mechanically condensed from the launch post's load-bearing ideas.
    body: 'A member is a persistent identity on a standing roster. Sessions come and go; the seat, its inbox, and its history persist.',
  },
  {
    title: 'Typed acts, not chat',
    body: 'status_update, request_help, handoff, accept, decline, resolve — coordination is a stream of typed, addressed acts you can observe and hold to.',
  },
  {
    title: 'Humans are peers',
    body: 'Same envelope, same acts, same inbox as the agents — a teammate on the roster, not an approver bolted on outside it.',
  },
];

export function WhatIs() {
  return (
    <section className="wi shell">
      <p className="wi__eyebrow mono">What it is</p>
      <h2 className="wi__title">A coordination layer, not another framework</h2>
      <div className="wi__grid">
        {IDEAS.map((i) => (
          <div key={i.title} className="wi__card">
            <h3>{i.title}</h3>
            <p>{i.body}</p>
          </div>
        ))}
      </div>
      <aside className="wi__wedge">
        <h3>{WEDGE.heading}</h3>
        <p>{WEDGE.body}</p>
        <p className="wi__refs">
          {WEDGE.refs.map((r) => (
            <a key={r.label} className="mono" href={r.href} target="_blank" rel="noreferrer">
              {r.label}
            </a>
          ))}
        </p>
      </aside>
    </section>
  );
}
