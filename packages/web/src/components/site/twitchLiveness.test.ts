import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TWITCH_SDK_SRC,
  eyebrowFor,
  replayWhenDark,
  subscribeLiveness,
  type Liveness,
} from './twitchLiveness';
import { WATCH_COPY } from './watchCopy';

/** A stand-in for Twitch.Player that lets a test fire the events the real one fires. */
function fakePlayer(opts: { setCollection?: boolean } = {}) {
  const handlers = new Map<string, (() => void)[]>();
  const collections: string[] = [];
  return {
    player: {
      addEventListener: (e: string, cb: () => void) =>
        handlers.set(e, [...(handlers.get(e) ?? []), cb]),
      /* Omittable, because a viewer's SDK may predate the method — see replayWhenDark. */
      ...(opts.setCollection === false
        ? {}
        : { setCollection: (id: string) => void collections.push(id) }),
    },
    collections,
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

/**
 * The replay wiring (lane 01M32JE1ZP). The thing worth testing is not "does it swap" but WHEN it
 * claims to be replaying: a caption that says "replay" over a player that never started is the
 * defect ADR 428 took out of this slot, in new clothes.
 */
describe('replayWhenDark', () => {
  const R_EVENTS = { OFFLINE: 'offline', PLAY: 'play' };

  it('asks for the collection when the channel goes dark', () => {
    const { player, collections, fire } = fakePlayer();
    replayWhenDark(player, R_EVENTS, 'coll-1', () => {});
    expect(collections, 'nothing is swapped before the channel says it is dark').toEqual([]);
    fire('offline');
    expect(collections).toEqual(['coll-1']);
  });

  it('does NOT report a replay merely because it asked for one', () => {
    // The whole point: the request is not the outcome. An empty, private or wrong collection
    // never plays, and the caller must keep showing the office still rather than caption a void.
    let replayed = false;
    const { player, fire } = fakePlayer();
    replayWhenDark(player, R_EVENTS, 'coll-1', () => (replayed = true));
    fire('offline');
    expect(replayed).toBe(false);
  });

  it('reports a replay once the player actually plays after the swap', () => {
    let replayed = false;
    const { player, fire } = fakePlayer();
    replayWhenDark(player, R_EVENTS, 'coll-1', () => (replayed = true));
    fire('offline');
    fire('play');
    expect(replayed).toBe(true);
  });

  it('does NOT call a LIVE stream a replay — PLAY before any swap is the channel itself', () => {
    // A live channel fires PLAY too. Without the guard, a live stream would be captioned as
    // yesterday's recording the moment it started, which is worse than showing no replay at all.
    let replayed = false;
    const { player, fire } = fakePlayer();
    replayWhenDark(player, R_EVENTS, 'coll-1', () => (replayed = true));
    fire('play');
    expect(replayed).toBe(false);
  });

  it('swaps once, however many times the channel reports itself dark', () => {
    const { player, collections, fire } = fakePlayer();
    replayWhenDark(player, R_EVENTS, 'coll-1', () => {});
    fire('offline');
    fire('offline');
    fire('offline');
    expect(collections, 'a repeated OFFLINE must not restart the replay from the top').toEqual([
      'coll-1',
    ]);
  });

  it('degrades to doing nothing when the SDK has no setCollection', () => {
    // Same outcome as a blocked script: no swap, no replay claim, and the caller keeps the still.
    let replayed = false;
    const { player, fire } = fakePlayer({ setCollection: false });
    replayWhenDark(player, R_EVENTS, 'coll-1', () => (replayed = true));
    fire('offline');
    fire('play');
    expect(replayed).toBe(false);
  });
});

/**
 * The joint the lane (01M2XC9GNX) found untested: player events -> liveness -> the string a reader
 * sees. Each case drives a fake player's real listeners through `subscribeLiveness` into
 * `eyebrowFor`, so a swap that stops working goes red here. The no-event case matters most,
 * because a dead swap and correct SSR both print the neutral eyebrow.
 */
describe('the /watch eyebrow follows the player', () => {
  const EVENTS = { ONLINE: 'online', OFFLINE: 'offline' };
  function drive(fire: string[], replaying = false): string {
    const listeners: Record<string, () => void> = {};
    let state: Liveness = 'unknown';
    subscribeLiveness(
      { addEventListener: (e: string, cb: () => void) => (listeners[e] = cb) } as never,
      EVENTS,
      (s) => (state = s),
    );
    for (const e of fire) listeners[e]!();
    return eyebrowFor(state, replaying);
  }

  it('no event leaves the neutral SSR string', () => {
    expect(drive([])).toBe(WATCH_COPY.eyebrow);
  });
  it('ONLINE reads live', () => {
    expect(drive(['online'])).toBe(WATCH_COPY.eyebrowLive);
  });
  it('OFFLINE reads between sessions', () => {
    expect(drive(['offline'])).toBe(WATCH_COPY.eyebrowDark);
  });
  it('the latest event wins in both directions', () => {
    expect(drive(['offline', 'online'])).toBe(WATCH_COPY.eyebrowLive);
    expect(drive(['online', 'offline'])).toBe(WATCH_COPY.eyebrowDark);
  });
  it('a dark channel playing a replay says so; live beats replay', () => {
    expect(drive(['offline'], true)).toBe(WATCH_COPY.eyebrowReplay);
    expect(drive(['online'], true)).toBe(WATCH_COPY.eyebrowLive);
  });
  it('WatchPage renders eyebrowFor from the state the subscription sets', () => {
    const src = readFileSync(fileURLToPath(new URL('./WatchPage.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/watch-hero__eyebrow[^>]*>\s*\{eyebrowFor\(liveness, replaying\)\}/);
    expect(src).toMatch(/subscribeLiveness\([^)]*\([^)]*\)\s*=>\s*\{\s*if \(!cancelled\) setLiveness\(state\)/);
  });
});
