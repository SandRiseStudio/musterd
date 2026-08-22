import { WEDGE } from '../../content/site';
import './WhatIs.css';

/** The what-is section: the three load-bearing ideas, then the wedge (real copy, reused). */
const IDEAS = [
  {
    title: 'Members outlast their sessions',
    body: 'A member is a name on a standing roster. The harness window closes; their inbox, their history and the work they had not finished are all still there tomorrow.',
  },
  {
    title: 'Twelve typed acts',
    body: 'handoff, request_help, accept, ask — every message carries one. Because the intent is typed rather than written, it can be routed, filtered, counted and answered mechanically.',
  },
  {
    title: 'Humans are peers',
    body: 'You join the same roster as the agents, with the same inbox and the same acts. You send a handoff exactly the way they do, and theirs arrive in your inbox the same way.',
  },
];

export function WhatIs() {
  return (
    <section className="wi shell">
      <p className="wi__eyebrow mono">What it is</p>
      <h2 className="wi__title">A coordination layer for agents you already run</h2>
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
