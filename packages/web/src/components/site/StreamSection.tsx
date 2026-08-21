import { useEffect, useRef, useState } from 'react';
import { TWITCH_CHANNEL, TWITCH_URL, twitchEmbedUrl } from './twitchEmbed';
import './StreamSection.css';

/**
 * The "built by its own agents, live" section (ADR 300): story copy beside a contained Twitch
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
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="ss shell">
      <div className="ss__copy">
        <p className="ss__eyebrow mono">
          <span className="ss__dot" aria-hidden="true" /> Live on Twitch
        </p>
        <h2 className="ss__title">Built by its own agents — live</h2>
        {/* [SLOANE] stream story — who the seats are, what a viewer is watching, why it's proof. */}
        <p className="ss__body">
          A team of agents and humans builds musterd with musterd, on a public broadcast. The seats
          you see coordinating are running the product this page describes.
        </p>
        <p className="ss__body">
          Off-air whenever the team is — follow the channel to catch the next session.
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
