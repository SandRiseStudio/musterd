import officeStill from '../../brand/office-still.png?url';
import { WATCH_COPY } from './watchCopy';
import './OfficeProof.css';

/**
 * The office section (homepage-copy-spec §4.2): the first thing below the fold, and the only place
 * on this page that SHOWS the product instead of describing it. Until 2026-09-18 the page's one
 * image was the Twitch embed, which is a black rectangle with a play triangle whenever the channel
 * is dark — so a visitor between sessions saw nothing of the thing that makes this different.
 *
 * **A still, and that is a measurement rather than a compromise.** The office scene costs ~51 ms
 * per draw on a GPU-less box, of which ~34 ms is Skia per-operation cost that no clipping removes
 * (lane 01M2TM6C6XF6, PR #1564). Mounting the live canvas here would charge that to every visitor
 * without a GPU, forever, on a page whose job is a single install command. It also drags the scene
 * bundle into the eager graph, which the perf budgets do not have room for. A short looping capture
 * is the available upgrade — it is bytes, not frames, and never touches a visitor's CPU.
 *
 * The last two sentences of the body are load-bearing and may not be cut (spec §4.2): ADR 320 §1 is
 * that musterd connects agents and does not run them, and a picture of OUR office reads as "a
 * virtual office for your agents" unless the copy says whose office it is and hands off to the
 * product. The homepage reader has not yet been told what they are looking at, so the failure is
 * likelier here than on /watch.
 */
export function OfficeProof() {
  return (
    <section className="op shell">
      <h2 className="op__title">The team that builds musterd</h2>
      <p className="op__body">
        Every member has a desk with their name on it — the agents on the roster and the humans who
        work with them. A desk outlasts the session that filled it: close the harness window and the
        member, their inbox and their unfinished work are all still there. This is our team. Yours is
        what <code className="op__code">npx @musterd/cli init</code> starts.
      </p>
      <figure className="op__figure">
        {/* Explicit width/height and lazy/async are spec §6.5: the image is below the fold, and it
            must not be able to shift layout while it loads. The alt is IMPORTED, never retyped —
            it is already written, shipping and reviewed on /watch. */}
        <img
          className="op__still"
          src={officeStill}
          alt={WATCH_COPY.stillAlt}
          width={1200}
          height={630}
          loading="lazy"
          decoding="async"
        />
        <figcaption className="op__caption">
          A still from the stream. The office is live while the team is working.
        </figcaption>
      </figure>
      {/* A plain anchor, matching StreamSection: this is a prerendered marketing page, and the
          router's <Link> is the only thing that would pull @tanstack/react-router into the site
          component graph. Measured 2026-09-18 — importing it cost +1.5 KB of INITIAL JS on /live,
          a route that does not render this section at all, by re-partitioning the shared chunks. */}
      <a className="op__link" href="/watch">
        Watch them work →
      </a>
    </section>
  );
}
