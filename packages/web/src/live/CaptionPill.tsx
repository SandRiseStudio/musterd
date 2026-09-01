import type { Caption } from './captions';

/**
 * The room's narration, as a pill.
 *
 * The caption rail (first-five-seconds §2) is one transient plain-language sentence about a real
 * moment — it is how a stranger learns the vocabulary, by seeing the word and the choreography it
 * names at the same time. It used to render as flat italic mono in the chrome, which made every
 * moment look identical: an acceptance and an urgent ask were the same grey line (nick, 2026-08-31).
 *
 * Two carriers of meaning, both of which the composing code already knew and used to throw away:
 * a dot in the ACTOR's own colour — the same `memberColor` their floor plate, roster chip and rail
 * dot carry, so the sentence is tied to a person rather than floating free — and a tone accent from
 * the act family. Colour is never the only signal: the sentence says the same thing in words, and
 * the tone only tints a border and a dot.
 *
 * One component, two mounts (`WorkStack`'s header on /live, `OfficeOverlay`'s card on /broadcast),
 * because those two surfaces have drifted apart before and the caption is the same object on both.
 */
export function CaptionPill({
  caption,
  color,
  className,
}: {
  caption: Caption | null;
  /** The actor's `memberColor`; omitted (or unknown) falls back to the tone's own accent. */
  color?: string | undefined;
  className?: string | undefined;
}) {
  // aria-live must be on an element that EXISTS before the text arrives, or the first caption of a
  // session is announced by nothing — the region has to be in the DOM to be watched.
  return (
    <span className={`lc-caption${className ? ` ${className}` : ''}`} aria-live="polite">
      {caption && (
        <span className={`lc-caption__pill is-${caption.tone}`}>
          <i
            className="lc-caption__dot"
            {...(color ? { style: { background: color } } : {})}
            aria-hidden="true"
          />
          <span className="lc-caption__text">{caption.text}</span>
        </span>
      )}
    </span>
  );
}
