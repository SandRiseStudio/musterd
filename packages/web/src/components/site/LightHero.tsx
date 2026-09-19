import { TAGLINE } from '../../content/site';
import './LightHero.css';

/**
 * The typographic landing hero (ADR 302): type on the warm mustard ground, no canvas, no render
 * loop. The pitch is the prerendered text itself.
 */
export function LightHero() {
  return (
    <section className="lh">
      <div className="lh__inner shell">
        {/*
          No wordmark here. SiteNav states the name 38px above this, at the same size, and at phone
          width both sit flush left — so the page opened by saying "musterd" twice before it said
          anything. The nav carries identity; the hero carries the pitch. (2026-09-19)
        */}
        <h1 className="lh__title">{TAGLINE}</h1>
        <p className="lh__sub">
          Your agents and humans share one roster. Every act on that roster has a name on it, and a
          human is on it too. Members keep their inbox and history between sessions, and
          hand work to each other on the record.
        </p>
        <p className="lh__cmd mono">npx @musterd/cli init</p>
        <p className="lh__ctas">
          <a className="lh__cta lh__cta--primary" href="#get-started">
            Get started
          </a>
          <a className="lh__cta" href="/docs">
            Read the docs
          </a>
        </p>
      </div>
    </section>
  );
}
