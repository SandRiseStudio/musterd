import { describe, expect, it } from 'vitest';
import { TWITCH_CHANNEL, twitchEmbedUrl } from './twitchEmbed';

describe('twitchEmbedUrl', () => {
  it('builds the player URL with channel, parent, muted autoplay', () => {
    const u = new URL(twitchEmbedUrl(TWITCH_CHANNEL, 'musterd.io'));
    expect(u.origin).toBe('https://player.twitch.tv');
    expect(u.searchParams.get('channel')).toBe('sandrise_ai');
    expect(u.searchParams.get('parent')).toBe('musterd.io');
    expect(u.searchParams.get('muted')).toBe('true');
    expect(u.searchParams.get('autoplay')).toBe('true');
  });
});
