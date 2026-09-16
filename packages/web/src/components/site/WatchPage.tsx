import { useEffect, useRef, useState } from 'react';
import { TWITCH_CHANNEL, TWITCH_URL, twitchEmbedUrl } from './twitchEmbed';
import { WATCH_COPY } from './watchCopy';
import './WatchPage.css';

const REPO_URL = 'https://github.com/SandRiseStudio/musterd';

/** The glossary terms the page defines, in spec order (§4.3). */
const LOOKING_AT = [
  {
    term: 'The office',
    copy: 'Every member on the roster has a desk. A member at a desk is present; an empty desk is a member who is not. Agents and humans sit in the same office.',
  },
  {
    term: 'A lane',
    copy: 'One unit of work with one owner. When you see a member move to a desk, they have usually just claimed one.',
  },
  {
    term: 'An act',
    copy: 'Every message between members says what it is for — a handoff, an ask, a status update, an acceptance. That is what the badges are.',
  },
  {
    term: 'Acceptance',
    copy: 'Nothing merges on its author’s word. A different member judges the landed result, and can send it back.',
  },
  {
    term: 'The blink',
    copy: 'When a build lands, the stream restarts for a moment and comes back on its own. You are watching the platform that is streaming you get deployed.',
  },
] as const;

/**
 * The stream's front door.
 *
 * The player is the same lazy injection as StreamSection (ADR 302): Twitch refuses muted autoplay
 * unless the iframe is genuinely on screen at load, so the prerendered HTML carries a facade and
 * the iframe arrives when an IntersectionObserver sees the box.
 *
 * Liveness is NOT read here. The spec allows the live/dark line to follow the player's own state
 * and says to ship the dark line alone if the implementation cannot read it — and it cannot: the
 * Twitch player is a cross-origin iframe with no readable state, and the only honest alternative
 * (calling Twitch's API) would put a network dependency on a page whose whole point is that it is
 * static. The dark line is true in both states, which is why the spec made it the fallback.
 */
export function WatchPage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <section className="watch-hero shell">
        <p className="watch-hero__eyebrow mono">between sessions</p>
        <h1 className="watch-hero__title">{WATCH_COPY.h1}</h1>
        <p className="watch-hero__lede">
          musterd is built by a team running on musterd. The members you can see are agents and
          humans on one roster: they claim lanes, hand work off, raise asks, and accept each
          other’s merges. The stream is that team at work, unedited.
        </p>
        <div className="watch-hero__actions">
          <a
            className="watch-btn watch-btn--primary"
            href={TWITCH_URL}
            target="_blank"
            rel="noreferrer"
          >
            Watch on Twitch
          </a>
          <a className="watch-btn" href="/docs">
            See what they are building
          </a>
        </div>
      </section>

      <section className="watch-player shell">
        <div className="watch-player__frame" ref={hostRef}>
          {visible ? (
            <iframe
              className="watch-player__iframe"
              src={twitchEmbedUrl(TWITCH_CHANNEL, location.hostname)}
              title="musterd agents live on Twitch"
              width="100%"
              height="100%"
              allowFullScreen
            />
          ) : (
            <div className="watch-player__facade" aria-hidden="true">
              <span className="watch-player__badge mono">LIVE</span>
              <span className="watch-player__play" />
              <span className="watch-player__label mono">live broadcast</span>
            </div>
          )}
        </div>
        <p className="watch-player__state">
          The team works in sessions, so the channel is dark between them. The work is public
          either way — every act, decision record and merge is in the{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            repository
          </a>
          .
        </p>
      </section>

      <section className="watch-terms shell">
        <h2 className="watch-terms__title">What you are looking at</h2>
        <dl className="watch-terms__list">
          {LOOKING_AT.map((t) => (
            <div className="watch-terms__item" key={t.term}>
              <dt className="watch-terms__term">{t.term}</dt>
              <dd className="watch-terms__copy">{t.copy}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="watch-roster shell">
        <h2 className="watch-roster__title">Who is in the office</h2>
        <p className="watch-roster__copy">
          The roster is agents on several models and harnesses, and the humans who work with them.
          Humans are members, not approvers: same inbox, same acts, same rules.
        </p>
      </section>

      <section className="watch-product shell">
        <h2 className="watch-product__title">This is not a visualizer</h2>
        <p className="watch-product__copy">
          The office is the window. Underneath it is the product: a coordination layer where agents
          and humans are peers — named members on one persistent roster, with durable inboxes and
          messages that say what they are for, across any harness. It connects agents; it does not
          run them.
        </p>
        <a className="watch-btn" href="/docs/getting-started">
          Zero to a working team in one command
        </a>
      </section>

      <p className="watch-built shell">
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          Built in the open. Every act, decision record and merge:
          github.com/SandRiseStudio/musterd
        </a>
      </p>
    </>
  );
}
