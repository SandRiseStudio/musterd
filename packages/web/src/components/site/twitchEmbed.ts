export const TWITCH_CHANNEL = 'sandrise_ai';
export const TWITCH_URL = `https://www.twitch.tv/${TWITCH_CHANNEL}`;

/**
 * A Twitch COLLECTION of past sessions, played when the channel is dark.
 *
 * Hardcoded on purpose, and the cheapest of the three routes lane 01M32JE1ZP weighed. There is no
 * player parameter meaning "this channel's most recent VOD": resolving that needs Helix, which
 * needs a client id and an app token, and this repo holds no Twitch API credential of any kind —
 * `MUSTERD_STREAM_KEY` is the ingest key and cannot read. A collection id is PUBLIC, so it needs
 * no secret, no build-time network call and no runtime endpoint on a page whose whole point is
 * that it is prerendered.
 *
 * THE COST, stated because it is real and silent: the collection is curated by hand in the Twitch
 * dashboard. Nothing here notices if it stops being added to, so a stale collection looks exactly
 * like a fresh one. What it cannot do is look BROKEN — an empty or unreachable collection never
 * starts playing, and the office still stays where it is (StreamSection's replay gate).
 *
 * Created by nick 2026-09-21; falsify: open twitch.tv/collections/<this id> and find it empty,
 * private, or with nothing added since the last session.
 */
export const TWITCH_COLLECTION = 'oHDc4g501xg16g';
export const TWITCH_COLLECTION_URL = `https://www.twitch.tv/collections/${TWITCH_COLLECTION}`;

/**
 * player.twitch.tv iframe URL. `parent` is Twitch's embed allowlist — the embedding hostname.
 * Muted autoplay is deliberate: browsers permit it, and a muted playing embed still counts as a
 * concurrent Twitch viewer (ADR 302 records the falsifier if that policy changes).
 */
export function twitchEmbedUrl(channel: string, parent: string): string {
  const u = new URL('https://player.twitch.tv/');
  u.searchParams.set('channel', channel);
  u.searchParams.set('parent', parent);
  u.searchParams.set('muted', 'true');
  u.searchParams.set('autoplay', 'true');
  return u.toString();
}
