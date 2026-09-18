import { useEffect, useRef, useState } from 'react';
import { TWITCH_CHANNEL, TWITCH_URL } from './twitchEmbed';
import { loadTwitchSdk, subscribeLiveness, type Liveness } from './twitchLiveness';
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
    copy: 'Nothing ships on its author’s word. A different member judges the landed result, and can send it back.',
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
  const mountRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  /**
   * `unknown` until the player says otherwise, and it stays `unknown` if the SDK never loads.
   * The prerendered HTML ships this state, so the copy it selects must be true either way —
   * the page must never GUESS which of §4.1's two strings applies.
   */
  const [liveness, setLiveness] = useState<Liveness>('unknown');

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

  /**
   * Construct the player once the box is genuinely on screen, and let it tell us the state.
   *
   * Same trigger as the facade it replaces: Twitch refuses muted autoplay unless the player meets
   * its visibility requirement at load (ADR 302), so construction waits for `visible` exactly as
   * the hand-built iframe's injection did. The SDK builds the same iframe we did — measured
   * 2026-09-16, it emits `https://player.twitch.tv/?channel&parent&muted&autoplay`, the same
   * origin, path and parameters as `twitchEmbedUrl` — and additionally sets `allow="autoplay;
   * fullscreen"`, which our hand-written iframe did not carry at all.
   *
   * Every failure here lands on `unknown`, which is why nothing in this effect reports an error: a
   * viewer with a content blocker gets the neutral copy and a working page, not a broken one.
   */
  useEffect(() => {
    if (!visible) return;
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;
    void loadTwitchSdk()
      .then((twitch) => {
        if (cancelled) return;
        const player = new twitch.Player(mount, {
          channel: TWITCH_CHANNEL,
          parent: [location.hostname],
          muted: true,
          autoplay: true,
          width: '100%',
          height: '100%',
        });
        subscribeLiveness(player, twitch.Player, (state) => {
          if (!cancelled) setLiveness(state);
        });
      })
      .catch(() => {
        /* blocked, offline, or refused — `unknown` is the honest answer and already the state */
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  return (
    <>
      <section className="watch-hero shell">
        <p className="watch-hero__eyebrow mono">
          {liveness === 'live'
            ? WATCH_COPY.eyebrowLive
            : liveness === 'dark'
              ? WATCH_COPY.eyebrowDark
              : WATCH_COPY.eyebrow}
        </p>
        <h1 className="watch-hero__title">{WATCH_COPY.h1}</h1>
        <p className="watch-hero__lede">
          musterd is built by a team running on musterd. The members you can see are agents and
          humans on one roster: they claim their own lanes, hand work off, raise asks, and can
          decline what they are handed. The stream is that team at work, unedited.
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
            <div className="watch-player__mount" ref={mountRef} />
          ) : (
            <div className="watch-player__facade" aria-hidden="true">
{/*
                A facade may not assert a state the page has not established. This markup is PRERENDERED,
                so it ships before any player loads and cannot know whether the channel is live — and it
                shipped an all-caps state badge and a state label regardless, which on a dark channel was
                a stranger's first impression of the project. /watch carried the same two strings while
                reading REAL liveness for its eyebrow one element over.
              
                The badge is gone rather than neutralised: a state badge that cannot read state has nothing
                to say, and a greyed one invites the reader to decide what grey means. The play triangle
                stays — it is a player affordance, not a claim. (homepage-copy-spec §4.3)
              */}
              <span className="watch-player__play" />
              <span className="watch-player__label mono">musterd on Twitch</span>
            </div>
          )}
        </div>
        <p className="watch-player__state">
          {liveness === 'live' ? (
            WATCH_COPY.stateLive
          ) : (
            <>
              {WATCH_COPY.stateDark}{' '}
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                repository
              </a>
              .
            </>
          )}
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
