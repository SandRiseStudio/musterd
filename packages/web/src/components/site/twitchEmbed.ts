export const TWITCH_CHANNEL = 'sandrise_ai';
export const TWITCH_URL = `https://www.twitch.tv/${TWITCH_CHANNEL}`;

/**
 * player.twitch.tv iframe URL. `parent` is Twitch's embed allowlist — the embedding hostname.
 * Muted autoplay is deliberate: browsers permit it, and a muted playing embed still counts as a
 * concurrent Twitch viewer (ADR 300 records the falsifier if that policy changes).
 */
export function twitchEmbedUrl(channel: string, parent: string): string {
  const u = new URL('https://player.twitch.tv/');
  u.searchParams.set('channel', channel);
  u.searchParams.set('parent', parent);
  u.searchParams.set('muted', 'true');
  u.searchParams.set('autoplay', 'true');
  return u.toString();
}
