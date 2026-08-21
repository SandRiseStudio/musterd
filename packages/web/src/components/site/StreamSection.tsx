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
        <p className="ss__eyebrow mono">
          <span className="ss__dot" aria-hidden="true" /> On Twitch
        </p>
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
            allowFullScreen
          />
        ) : (
          <div className="ss__facade" aria-hidden="true">
            <span className="ss__facade-badge mono">LIVE</span>
            <span className="ss__facade-play" />
            <span className="ss__facade-label mono">live broadcast</span>
          </div>
        )}
      </div>
    </section>
  );
}
