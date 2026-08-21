import { MusterdChip } from '../../brand/MusterdWord';
import { SITE_ONE_LINER } from '../../brand/siteMeta';
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
        {/* [SLOANE] sub-line — currently the brand one-liner verbatim. */}
        <p className="lh__sub">{SITE_ONE_LINER}</p>
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
