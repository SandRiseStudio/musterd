import { WATCH_COPY } from './watchCopy';

/**
 * Whether the channel is live, as the page is allowed to know it.
 *
 * `unknown` is the honest starting value and the permanent fallback: the page is prerendered, so
 * the HTML that ships cannot know, and a viewer whose browser blocks the Twitch script never
 * learns. Copy for `unknown` must be true in either state (spec §4.1's neutral eyebrow).
 */
export type Liveness = 'unknown' | 'live' | 'dark';

/** Twitch's interactive-player SDK. Not `embed.twitch.tv` — that is the full embed with chat. */
export const TWITCH_SDK_SRC = 'https://player.twitch.tv/js/embed/v1.js';

/**
 * Minimal shape of the bits of `Twitch.Player` this module uses, so the wiring is testable without
 * loading a third-party script.
 */
export interface TwitchPlayerLike {
  addEventListener: (event: string, cb: () => void) => void;
  /** Swap the player's source to a collection. Optional: an older SDK may not expose it. */
  setCollection?: (collectionId: string, videoId?: string) => void;
}
export interface TwitchGlobal {
  Player: (new (el: HTMLElement | string, opts: Record<string, unknown>) => TwitchPlayerLike) & {
    ONLINE: string;
    OFFLINE: string;
    READY: string;
    PLAY: string;
  };
}

/**
 * Subscribe to the channel's liveness through a constructed player.
 *
 * MEASURED 2026-09-16 against the real SDK, because the docs describe both events as transitions
 * ("loaded channel GOES online") and a transition-only signal would be useless to a page that
 * arrives mid-state:
 *   - live channel  — READY at +3.3s, then ONLINE at +3.5s
 *   - dark channel  — READY at +1.8s, then OFFLINE at +1.8s
 * Both fire on FIRST load, so dark is distinguishable from not-yet-loaded, which is the whole
 * reason this is implementable at all.
 *
 * `getPlaybackStats()` was measured and REJECTED as the signal: at READY+9s on a live channel it
 * still read `hlsLatencyBroadcaster: 0`, `videoResolution: '0x0'`, `fps: 0`. It reports playback,
 * not availability, so it cannot tell a dark channel from one that simply has not started.
 */
/**
 * The /watch eyebrow for a liveness reading. This is the joint between the player's events and the
 * string a reader sees: `unknown` (no event yet, or the SDK blocked) must stay neutral, because
 * a dead swap and correct SSR would otherwise print the same bytes (lane 01M2XC9GNX). Live wins
 * over a replay, and a replay wins over plain dark, since the replay is what is on screen.
 */
export function eyebrowFor(liveness: Liveness, replaying: boolean): string {
  if (liveness === 'live') return WATCH_COPY.eyebrowLive;
  if (replaying) return WATCH_COPY.eyebrowReplay;
  if (liveness === 'dark') return WATCH_COPY.eyebrowDark;
  return WATCH_COPY.eyebrow;
}

export function subscribeLiveness(
  player: TwitchPlayerLike,
  events: { ONLINE: string; OFFLINE: string },
  onChange: (state: Liveness) => void,
): void {
  player.addEventListener(events.ONLINE, () => onChange('live'));
  player.addEventListener(events.OFFLINE, () => onChange('dark'));
}

/**
 * Load the SDK once per document, resolving to the global it defines.
 *
 * Rejects rather than hanging when the script fails — a blocked third-party script is an ordinary
 * outcome (content blockers, strict privacy modes, an offline viewer), and the caller's answer to
 * it is to stay `unknown`, not to retry or to guess.
 */
export function loadTwitchSdk(doc: Document = document): Promise<TwitchGlobal> {
  const w = window as unknown as { Twitch?: TwitchGlobal };
  if (w.Twitch?.Player) return Promise.resolve(w.Twitch);
  const existing = doc.querySelector<HTMLScriptElement>(`script[src="${TWITCH_SDK_SRC}"]`);
  const el = existing ?? doc.createElement('script');
  const ready = new Promise<TwitchGlobal>((resolve, reject) => {
    el.addEventListener('load', () =>
      w.Twitch?.Player ? resolve(w.Twitch) : reject(new Error('Twitch SDK loaded without Player')),
    );
    el.addEventListener('error', () => reject(new Error('Twitch SDK failed to load')));
  });
  if (!existing) {
    el.src = TWITCH_SDK_SRC;
    el.async = true;
    doc.head.appendChild(el);
  }
  return ready;
}

/**
 * When the channel goes dark, play a collection of past sessions instead — and say so only once it
 * is actually playing.
 *
 * TWO EVENTS, AND THE SECOND ONE IS THE POINT. Asking for the collection is not the same as
 * getting it: the id may be wrong, the collection may be empty or private, Twitch may decline. So
 * OFFLINE only REQUESTS the swap, and `onReplay` fires on the player's own PLAY event afterwards.
 * A caller that shows a replay caption on the request rather than on the play would caption a
 * black rectangle — which is the exact defect ADR 428 removed from this slot, wearing new clothes.
 *
 * `switched` guards PLAY the other way round: a live channel fires PLAY too, and without the flag
 * a live stream would be captioned as a replay the moment it started. Only a PLAY that follows our
 * own swap counts.
 *
 * `setCollection` is optional on the interface because a viewer's SDK may predate it. Absent, the
 * swap simply never happens, `onReplay` never fires, and the caller keeps the still — the same
 * outcome as a blocked script, which the caller already handles.
 */
export function replayWhenDark(
  player: TwitchPlayerLike,
  events: { OFFLINE: string; PLAY: string },
  collectionId: string,
  onReplay: () => void,
): void {
  let switched = false;
  player.addEventListener(events.OFFLINE, () => {
    if (switched || !player.setCollection) return;
    switched = true;
    player.setCollection(collectionId);
  });
  player.addEventListener(events.PLAY, () => {
    if (switched) onReplay();
  });
}
