import { useEffect, useRef, useState } from 'react';
import officeStill from '../../brand/office-still.png?url';
import { TWITCH_CHANNEL, TWITCH_URL } from './twitchEmbed';
import { type Liveness, loadTwitchSdk, subscribeLiveness } from './twitchLiveness';
import { WATCH_COPY } from './watchCopy';
import './StreamSection.css';

/**
 * The stream section: the homepage's ONE office, directly under the hero (ADR 428).
 *
 * It used to be the second of two. `OfficeProof` carried a still and this carried the player, each
 * for a written reason that held on its own — and measured 2026-09-21 at 390x844 on a live channel,
 * both fitted in one viewport 418px apart, so a stranger saw the same room twice, one copy labelled
 * "A still from the stream". Neither block was wrong; their composition was. There is now one
 * office slot and the still is the player's OFFLINE state rather than a separate figure.
 *
 * **Why the still cannot simply be dropped.** It exists because a dark channel renders Twitch's own
 * offline card — a black rectangle — and that was a stranger's first impression of the project for
 * weeks. The channel is dark most hours of most days, so the offline state is the common one, not
 * the edge case. Overlaying the still on the player keeps that fix while spending one slot.
 *
 * **Why the overlay rather than skipping the player when dark.** Liveness is only knowable THROUGH
 * a constructed player: `player.twitch.tv` is cross-origin and exposes nothing, so the only signal
 * is the SDK's ONLINE/OFFLINE event (`twitchLiveness.ts`), which requires the player to exist.
 * Deciding "don't mount it" would need an answer before the question can be asked. The player
 * therefore always mounts and the still covers it when the answer comes back `dark` — which also
 * means the box never changes size and nothing below it shifts.
 *
 * The SDK replaces the hand-built iframe for the same reason `/watch` uses it: it emits the same
 * origin, path and parameters, and additionally carries `allow="autoplay; fullscreen"`, which the
 * hand-written iframe did not. ADR 302's muted-autoplay viewer count still rests on the
 * IntersectionObserver gate below — Twitch refuses autoplay to a player that is not genuinely on
 * screen at load, and a player that never autoplays never counts the viewer.
 */
export function StreamSection() {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  /**
   * `unknown` until the player says otherwise, and it stays `unknown` if the SDK never loads (a
   * content blocker, an offline reader). The prerendered HTML ships this state, so what `unknown`
   * shows must be true either way — it shows the still, which is honest in both: it is a picture of
   * the office captioned as a still, never presented as a live view.
   */
  const [liveness, setLiveness] = useState<Liveness>('unknown');

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

  /**
   * Construct the player once the box is on screen, and let it tell us the state.
   *
   * Every failure lands on `unknown`, which is why nothing here reports an error: a viewer with a
   * content blocker gets the still and a working page, not a broken one.
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

  const showStill = liveness !== 'live';

  return (
    <section className="ss shell">
      {/* The title is a direct child, not part of `.ss__copy`, purely so the grid can order it
          independently: stacked on a phone the reader must meet the heading BEFORE the player,
          or a video arrives with no idea attached to it. */}
      <h2 className="ss__title">Watch its own agents build it, live</h2>
      <div className="ss__copy">
        <p className="ss__body">
          musterd is built by a team running on musterd. Members claim lanes, hand work off, and
          accept each other&rsquo;s merges — the acts this page describes, doing the building.
        </p>
        <p className="ss__body">
          Every member has a desk with their name on it. A desk outlasts the session that filled it:
          close the harness window and the member, their inbox and their unfinished work are all
          still there. This is our team. Yours is what{' '}
          <code className="ss__code">npx @musterd/cli init</code> starts.
        </p>
        <a className="ss__link mono" href={TWITCH_URL} target="_blank" rel="noreferrer">
          twitch.tv/{TWITCH_CHANNEL}
        </a>
        <a className="ss__watch" href="/watch">
          What you are watching &rarr;
        </a>
      </div>
      <div className="ss__stage">
        <div className="ss__player" ref={hostRef}>
          <div className="ss__mount" ref={mountRef} />
          {/* The offline state, stacked ON the player rather than replacing it, so the box never
              resizes and nothing below it moves. It carries real alt text rather than being hidden
              from assistive tech: when it is showing it IS the content, not decoration over it.
              The alt is IMPORTED, never retyped — already written, shipping and reviewed on
              /watch, and two surfaces describing one image differently is how that drifts. */}
          {showStill && (
            <img
              className="ss__still"
              src={officeStill}
              alt={WATCH_COPY.stillAlt}
              // Explicit dimensions so it cannot shift layout, and EAGER with a high priority —
              // the opposite of what this image carried below the fold. It is now the first
              // picture on the page and ships in the prerendered HTML, so `loading="lazy"` would
              // deprioritise the one visual a reader is waiting on.
              width={1200}
              height={630}
              fetchPriority="high"
              decoding="async"
            />
          )}
        </div>
        {/* One caption, and it must be true in BOTH states because it is rendered in both: it says
            what the reader is looking at without inventing a schedule (watch-page-copy-spec §2). */}
        <p className="ss__caption">
          {showStill
            ? 'The team works in sessions, so the channel is dark between them. This is a still of the office; the work lands in the open repository either way.'
            : 'Live now. Every act you see lands in the open repository.'}
        </p>
      </div>
    </section>
  );
}
