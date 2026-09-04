import { PROTOCOL_VERSION, type Envelope, type LaneBoard, type MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The broadcast reel, rendered — and specifically the wiring of its tick guard, which was the one
 * claim in #1158 that no test held.
 *
 * **Why a spy and not a timer.** The guard lives in a `useEffect`, and this package renders with
 * `react-dom/server` on purpose (`AsksStrip.render.test.ts` sets out the reasoning: no jsdom, no
 * testing-library, no headless Chromium on a laptop that feels it). Effects never run there, so the
 * effect BODY is out of reach of any test here — but its *input* is not, because `reelTicks` is
 * computed in render. Pinning the call is what makes the pure tests in `reel.test.ts` mean something
 * about this component rather than about an unused function: together they hold "the reel ticks
 * exactly when it should", which was the untested claim.
 *
 * **The division of labour, since the spy hides it** (dolly, reviewing #1180). The mock below
 * reimplements `reelTicks` rather than delegating to it, so this file holds the WIRING and none of
 * the logic: weaken the real predicate and every test here still passes. That is deliberate — a
 * wiring pin that also asserted the answer would fail for two unrelated reasons and tell you
 * neither. `reel.test.ts` owns the logic half, and the two are only a pair if both exist.
 *
 * What this pair still does not hold, stated plainly rather than implied: that `setInterval` is
 * actually called on the true branch. That needs a renderer which runs effects, and adding one is a
 * dependency decision for the package (`packages/web/AGENTS.md`), not a thing to smuggle in with a
 * test. The gap is now one line wide instead of the whole predicate.
 */

const reelTicks = vi.fn((loudCount: number, cardCount: number) => loudCount > 0 || cardCount > 1);

vi.mock('./reel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reel')>();
  return { ...actual, reelTicks: (l: number, c: number) => reelTicks(l, c) };
});

const { AsksReel } = await import('./AsksReel');

const roster = [
  { name: 'nick', kind: 'human' },
  { name: 'izzo', kind: 'agent' },
] as unknown as MemberSummary[];

/** An ask envelope. `agoMs` is how long ago it was minted, which is what decides its clock. */
const ask = (id: string, tier: string, agoMs: number, meta: Record<string, unknown> = {}): Envelope =>
  ({
    id,
    v: PROTOCOL_VERSION,
    team: 'revive',
    from: 'izzo',
    to: { kind: 'member', name: 'nick' },
    act: 'ask',
    body: `body of ${id}`,
    thread: null,
    meta: { species: 'approve', tier, ...meta },
    ts: Date.now() - agoMs,
  }) as Envelope;

/** A lane sitting in acceptance — the review half of the rotation. */
const lane = (id: string) =>
  ({
    id,
    title: `lane ${id}`,
    state: 'awaiting_acceptance',
    owner_seat: 'izzo',
    updated_at: Date.now(),
  }) as never;

const board = (...ids: string[]) => ({ lanes: ids.map(lane) }) as unknown as LaneBoard;

const render = (envelopes: Envelope[], b: LaneBoard | null = null) =>
  renderToStaticMarkup(createElement(AsksReel, { envelopes, roster, board: b }));

const DAYS_3 = 3 * 24 * 60 * 60 * 1000;

describe('the reel wears the shown seat and drains its clock', () => {
  it('carries the asker\'s hue on the reel and the clock fraction on the avatar', () => {
    const html = render([ask('h1', 'blocking', 1000)]);
    expect(html).toMatch(/class="bc-reel[^"]* has-lead"[^>]*style="--lc-asks-hue:hsl\(/);
    expect(html).toMatch(/bc-reel__who is-timed"[^>]*--lc-ask-frac:0\.9\d+/);
  });
  it('colours a review row by the lane owner, with no clock to draw', () => {
    const html = render([], board('L1'));
    expect(html).toMatch(/class="bc-reel has-lead"/);
    expect(html).not.toContain('--lc-ask-frac');
  });
});

describe('the reel asks reelTicks whether it needs a clock', () => {
  beforeEach(() => reelTicks.mockClear());

  it('passes the loud count AND the card count — not the loud count alone', () => {
    render([ask('a1', 'blocking', 1000)]);
    expect(reelTicks).toHaveBeenCalledWith(1, 1);
  });

  it('reports zero loud with a rotation when the stage holds only lanes in review', () => {
    // The production shape the guard exists for, built end to end rather than asserted about
    // numbers: two lanes awaiting acceptance, and the only ask days past a standard deadline, so
    // `applyTierClock` has made it `lapsed` — nothing loud at all, two cards to turn.
    const html = render([ask('stale', 'standard', DAYS_3)], board('L1', 'L2'));
    expect(html).toContain('1 elapsed');
    expect(html).toContain('2 in review');
    expect(reelTicks).toHaveBeenCalledWith(0, 2);
    // And the reel is genuinely rotating — the dots only render above one card.
    expect(html).toContain('bc-reel__dots');
  });

  it('reports nothing to turn when a single settled ask is all there is', () => {
    render([ask('done', 'standard', DAYS_3)]);
    expect(reelTicks).toHaveBeenCalledWith(0, 0);
  });
});
