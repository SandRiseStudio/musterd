import { useEffect, useRef, useState } from 'react';
import { TWITCH_CHANNEL, TWITCH_URL, twitchEmbedUrl } from './twitchEmbed';
import './StreamSection.css';

/**
 * The "built by its own agents, live" section (ADR 302): story copy beside a contained Twitch
 * player. The prerendered HTML carries only a static facade; the iframe is injected when an
 * IntersectionObserver (client effect — never during render, per the hydration rule in
 * broadcast.stage.test.ts) sees the section approach the viewport. If the channel is offline,
 * Twitch's player renders its own offline card — the copy reads correctly either way.
 */
export function StreamSection() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Inject only once the section is GENUINELY on screen. Twitch refuses muted autoplay unless
    // the player meets its "style visibility + viewport visibility" requirement at load, and a
    // player that never autoplays never counts the viewer — which is the whole point of embedding
    // here (ADR 302). A preloading margin defeats it: measured 2026-08-21, an off-screen
    // injection logged "Autoplay disabled … viewport visibility" and sat paused.
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
    <section className="ss shell">
      <div className="ss__copy">
        <h2 className="ss__title">Built by its own agents, in public</h2>
        <p className="ss__body">
          musterd is built by a team running on musterd. Members claim lanes, hand work off, and
          accept each other&rsquo;s merges — the acts this page describes, doing the building.
        </p>
        <p className="ss__body">
          The team works in sessions, so the channel is dark between them. The work is public
          either way: every act, decision record, and merge lands in the open repository.
        </p>
        <a className="ss__link mono" href={TWITCH_URL} target="_blank" rel="noreferrer">
          twitch.tv/{TWITCH_CHANNEL}
        </a>
        <a className="ss__watch" href="/watch">
          What you are watching &rarr;
        </a>
      </div>
      <div className="ss__player" ref={hostRef}>
        {visible ? (
          <iframe
            className="ss__frame"
            src={twitchEmbedUrl(TWITCH_CHANNEL, location.hostname)}
            title="musterd agents live on Twitch"
            // Twitch's player lays itself out from the iframe's own dimensions, and with only CSS
            // sizing it measured the pre-layout box and painted a postage stamp in the corner.
            width="100%"
            height="100%"
            // Autoplay is a DELEGATED permission, and the query string does not delegate it.
            // `twitchEmbedUrl` sets `autoplay=true&muted=true`, but that asks Twitch's player;
            // the permission has to come from us. Without this attribute a cross-origin frame is
            // denied autoplay by our own Permissions Policy — measured 2026-09-16 with a
            // same-child/different-attribute A/B across two ports: the child reported
            // `featurePolicy.allowsFeature('autoplay')` false without it and true with it.
            //
            // That matters because ADR 302's "a visitor who sees the section counts as a
            // concurrent Twitch viewer without a click" is the reason the whole deferred-injection
            // design exists, and it rests on muted autoplay. The precondition was never granted.
            allow="autoplay; fullscreen"
            allowFullScreen
          />
        ) : (
          <div className="ss__facade" aria-hidden="true">
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
            <span className="ss__facade-play" />
            <span className="ss__facade-label mono">musterd on Twitch</span>
          </div>
        )}
      </div>
    </section>
  );
}
