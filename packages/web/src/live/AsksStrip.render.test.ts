import { PROTOCOL_VERSION, type Envelope, type MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AsksStrip } from './AsksStrip';
import type { LiveConfig } from './client';

/**
 * What the rail actually RENDERS for an ask whose clock ran out — the half of the lapsed-ask fix
 * that `asks.test.ts` cannot see. A derivation test can prove the state is `lapsed` and still leave
 * the strip painting "timed out" in danger red beside an Approve button, because the mapping from
 * state to markup lives in the component.
 *
 * **Rendered with `react-dom/server`, deliberately, and with no DOM.** The alternative was a
 * headless browser, and it is the wrong instrument twice over: it costs a whole Chromium per run on
 * a laptop that feels it (nick, 2026-09-01), and it would test the paint when what is in question is
 * the markup. `renderToStaticMarkup` needs no jsdom, no testing-library and no new dependency at all
 * — React is already here.
 *
 * Two constraints it buys with that, both worth naming. Effects never run, so this checks the first
 * frame and nothing after it; every claim below is a render-time one. And the suite's `include` is
 * `*.test.ts`, not `.tsx`, so the tree is built with `createElement` rather than JSX — widening that
 * glob for one file would be a repo-wide config change for a packages/web convenience.
 */

const cfg = { as: 'nick', team: 'revive' } as unknown as LiveConfig;
const roster = [
  { name: 'nick', kind: 'human' },
  { name: 'izzo', kind: 'agent' },
] as unknown as MemberSummary[];

const ask = (id: string, tier: string, agoMs: number): Envelope =>
  ({
    id,
    v: PROTOCOL_VERSION,
    team: 'revive',
    from: 'izzo',
    to: { kind: 'member', name: 'nick' },
    act: 'ask',
    body: `body of ${id}`,
    thread: null,
    meta: { species: 'approve', tier },
    ts: Date.now() - agoMs,
  }) as Envelope;

/**
 * An ask a human parked: the ask itself plus the `wait` that carries `ask_ref` back to it, which is
 * the only thing that produces `state: 'deferred'`. Two envelopes, so it returns a pair to spread.
 */
const deferredAsk = (id: string, agoMs: number): Envelope[] => [
  ask(id, 'standard', agoMs),
  {
    id: `${id}-wait`,
    v: PROTOCOL_VERSION,
    team: 'revive',
    from: 'nick',
    to: { kind: 'member', name: 'izzo' },
    act: 'wait',
    body: 'deciding — check back tomorrow',
    thread: null,
    meta: { ask_ref: id, until: 'tomorrow' },
    ts: Date.now() - agoMs + 1,
  } as Envelope,
];

const render = (envelopes: Envelope[]) =>
  renderToStaticMarkup(createElement(AsksStrip, { envelopes, roster, cfg }));

const DAYS_3 = 3 * 24 * 60 * 60 * 1000;

describe('the rail, rendered — a lapsed ask must not read as one waiting on you', () => {
  it('shows no "timed out" and no Approve/Deny for a standard ask days past its clock', () => {
    // The exact shape nick was looking at: an ask minted days ago against a five-minute tier
    // deadline, with no answer and no outcome envelope ever recorded.
    const html = render([ask('a1', 'standard', DAYS_3)]);
    expect(html).not.toContain('timed out');
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('Deny');
    expect(html).toContain('elapsed');
    expect(html).toContain('1 elapsed');
    // It says the contract let them proceed, and never that anything was approved.
    expect(html).toContain('was free to proceed');
    expect(html).not.toContain('approved');
    // And it is not quietly reclassified as something a human settled.
    expect(html).not.toContain('settled');
  });

  it('still shouts for a BLOCKING ask past its clock — that agent is stopped', () => {
    const html = render([ask('a2', 'blocking', DAYS_3)]);
    expect(html).toContain('timed out');
    expect(html).toContain('agent holding');
    expect(html).toContain('Approve');
  });

  it('leaves an ask with time left completely alone', () => {
    const html = render([ask('a3', 'standard', 1000)]);
    expect(html).toContain('left'); // the running countdown
    expect(html).toContain('Approve');
    expect(html).not.toContain('elapsed');
  });

  it('leads the rail with the live blocking ask, not the days-old lapsed one', () => {
    // The regression that matters most to a viewer: the rail has ONE lead slot, and before this a
    // stale card could hold it.
    const html = render([ask('lapsed', 'standard', DAYS_3), ask('live', 'blocking', 1000)]);
    const rail = html.slice(0, html.indexOf('lc-asks__sheet'));
    expect(rail).toContain('body of live');
    expect(rail).not.toContain('body of lapsed');
  });

  /**
   * The order of the sheet itself: `loud → deferred → lapsed`.
   *
   * The test above proves a lapsed ask is not FIRST, which is not the same claim and was the whole
   * of the coverage until 2026-09-02 — with only a lapsed and a live ask in play, swapping the last
   * two buckets is invisible. Confirmed by mutation before this test was written: reordering
   * `AsksStrip.tsx`'s `cards` to `[...loud, ...lapsed, ...deferred]` left all 867 web tests green.
   * That ordering is the difference between "someone is deciding this" and "the clock decided it",
   * and it is what a reader scans top-down to find what still needs them.
   */
  it('orders the sheet loud, then deferred, then lapsed — a deferred ask outranks a dead one', () => {
    const html = render([
      ask('lapsed', 'standard', DAYS_3),
      ...deferredAsk('deciding', DAYS_3),
      ask('live', 'blocking', 1000),
    ]);
    const at = (id: string) => html.indexOf(`body of ${id}`);
    // All three are on the page — an ordering assertion over a missing card proves nothing.
    expect(at('live')).toBeGreaterThan(-1);
    expect(at('deciding')).toBeGreaterThan(-1);
    expect(at('lapsed')).toBeGreaterThan(-1);
    expect(at('live')).toBeLessThan(at('deciding'));
    expect(at('deciding')).toBeLessThan(at('lapsed'));
    // And the counts agree with the buckets the order was built from.
    expect(html).toContain('1 elapsed');
  });
});
