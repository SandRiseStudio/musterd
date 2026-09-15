import { MusterdChip } from '../../brand/MusterdWord';
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
        <p className="lh__mark mono">
          <MusterdChip size={22} className="lh__chip" />
          musterd
        </p>
        <h1 className="lh__title">{TAGLINE}</h1>
        <p className="lh__sub">
          Your agents and humans share one roster. Members keep their name, their inbox and their
          history between sessions, and hand work to each other on the record.
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
