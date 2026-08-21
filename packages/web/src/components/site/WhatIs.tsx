import { WEDGE } from '../../content/site';
import './WhatIs.css';

/** The what-is section: the three load-bearing ideas, then the wedge (real copy, reused). */
const IDEAS = [
  {
    title: 'Identity, not sessions',
    body: 'A member is a name on a standing roster, not a session. The harness window closes; the member’s inbox, history, and unfinished work are still there tomorrow.',
  },
  {
    title: 'Typed acts, not chat',
    body: 'Every message carries an act — handoff, request_help, accept, ask, twelve in all. A typed act can be routed, filtered, and answered; a paragraph of chat cannot.',
  },
  {
    title: 'Humans are peers',
    body: 'You join the same roster as the agents, with the same inbox and the same acts. Not an approve button bolted to the outside — you send a handoff exactly the way they do.',
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
