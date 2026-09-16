import { describe, expect, it, vi } from 'vitest';
import { TWITCH_SDK_SRC, subscribeLiveness, type Liveness } from './twitchLiveness';
import { WATCH_COPY } from './watchCopy';

/** A stand-in for Twitch.Player that lets a test fire the events the real one fires. */
function fakePlayer() {
  const handlers = new Map<string, (() => void)[]>();
  return {
    player: {
      addEventListener: (e: string, cb: () => void) =>
        handlers.set(e, [...(handlers.get(e) ?? []), cb]),
    },
    fire: (e: string) => (handlers.get(e) ?? []).forEach((cb) => cb()),
  };
}

const EVENTS = { ONLINE: 'online', OFFLINE: 'offline' };

describe('subscribeLiveness', () => {
  it('reports live when the player says the channel is online', () => {
    const seen: Liveness[] = [];
    const { player, fire } = fakePlayer();
    subscribeLiveness(player, EVENTS, (s) => seen.push(s));
    expect(seen, 'nothing is known until the player says so').toEqual([]);
    fire('online');
    expect(seen).toEqual(['live']);
  });

  it('reports dark when the player says the channel is offline', () => {
    const seen: Liveness[] = [];
    const { player, fire } = fakePlayer();
    subscribeLiveness(player, EVENTS, (s) => seen.push(s));
    fire('offline');
    expect(seen).toEqual(['dark']);
  });

  it('follows the channel across a state change within one visit', () => {
    // The blink: a build lands, the stream restarts and comes back. A page open through that must
    // not be left asserting the state it saw first.
    const seen: Liveness[] = [];
    const { player, fire } = fakePlayer();
    subscribeLiveness(player, EVENTS, (s) => seen.push(s));
    fire('online');
    fire('offline');
    fire('online');
    expect(seen).toEqual(['live', 'dark', 'live']);
  });

  it('points at the interactive PLAYER sdk, not the full embed', () => {
    // embed.twitch.tv/embed/v1.js is Twitch.Embed — player plus chat, a different surface and a
    // heavier one. I named that URL wrongly when I first proposed this (2026-09-16).
    expect(TWITCH_SDK_SRC).toBe('https://player.twitch.tv/js/embed/v1.js');
  });
});

describe('the copy each liveness state selects', () => {
  it('has a string for every state, and the unknown one names no state', () => {
    expect(WATCH_COPY.eyebrow).toBe('from the office');
    expect(WATCH_COPY.eyebrowLive).toBe('live from the office');
    expect(WATCH_COPY.eyebrowDark).toBe('between sessions');
    // The fallback must stay true in both states — it is what a blocked script leaves standing.
    expect(WATCH_COPY.eyebrow).not.toMatch(/live|between sessions|offline/i);
  });

  it('keeps the dark state line as the one that is true either way', () => {
    // Spec §4.2: ship the dark line alone if liveness cannot be read. That is still the fallback,
    // so it must not claim the channel is dark in a way the live line contradicts.
    expect(WATCH_COPY.stateLive).toBe('Live now. Every act you see lands in the open repository.');
    expect(WATCH_COPY.stateDark).toMatch(/^The team works in sessions/);
  });

  it('never uses the word offline — it reads as broken', () => {
    for (const s of [WATCH_COPY.eyebrow, WATCH_COPY.eyebrowLive, WATCH_COPY.eyebrowDark])
      expect(s).not.toMatch(/offline/i);
  });
});
