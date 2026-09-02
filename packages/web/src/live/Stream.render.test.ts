import { PROTOCOL_VERSION, type Envelope, type MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Stream } from './Stream';

/**
 * What the stream row actually RENDERS for an act addressed to several people.
 *
 * The pure readers (`recipientScope` / `recipientNames`, covered in `format.test.ts`) can be
 * perfectly right while the row still paints "team" over an act addressed to named seats, because
 * the mapping from scope to markup lives in the component — and that is exactly the state /live was
 * in until 2026-09-02: the CLI printed `ryder | sloane`, the office scene walked to both desks, and
 * the panel a reader actually scans said "team". This file holds the wiring the readers cannot.
 *
 * Rendered with `react-dom/server` and no DOM, for the reasons `AsksStrip.render.test.ts` sets out:
 * no jsdom, no testing-library, no headless Chromium on a laptop that feels it. Effects never run,
 * so every claim here is a render-time one — which is all the recipient pill is.
 */

const roster = [
  { name: 'nick', kind: 'human' },
  { name: 'ryder', kind: 'agent' },
  { name: 'sloane', kind: 'agent' },
  { name: 'dolly', kind: 'agent' },
] as unknown as MemberSummary[];

const env = (over: Partial<Envelope>): Envelope =>
  ({
    id: '01ROW',
    v: PROTOCOL_VERSION,
    team: 'revive',
    from: 'nick',
    to: { kind: 'team' },
    act: 'request_help',
    body: 'Review please',
    thread: null,
    meta: null,
    ts: Date.now(),
    ...over,
  }) as Envelope;

const render = (e: Envelope) =>
  renderToStaticMarkup(
    createElement(Stream, { envelopes: [e], roster, liveIds: new Set<string>() }),
  );

describe('the stream row names an eligible set instead of calling it a team act', () => {
  it('lists every seat of the set, joined by "or"', () => {
    const html = render(env({ meta: { eligible: ['ryder', 'sloane'] } }));
    expect(html).toContain('ryder');
    expect(html).toContain('sloane');
    expect(html).toContain('lc-to--eligible');
    expect(html).toContain('>or<');
    // It must NOT fall back to the anonymous team pill — that was the whole defect.
    expect(html).not.toContain('lc-to--team');
  });

  it('carries all four at the MAX_ELIGIBLE cap', () => {
    const html = render(env({ meta: { eligible: ['ryder', 'sloane', 'dolly', 'nick'] } }));
    for (const n of ['ryder', 'sloane', 'dolly']) expect(html).toContain(n);
    // Three joiners for four seats — a dropped name would show as two.
    expect(html.match(/>or</g)?.length).toBe(3);
  });

  it('still renders a plain team act as team', () => {
    const html = render(env({ meta: null }));
    expect(html).toContain('lc-to--team');
    expect(html).not.toContain('lc-to--eligible');
  });

  it('leaves a direct 1:1 exactly as it was — one name, no joiner', () => {
    const html = render(env({ to: { kind: 'member', name: 'ryder' } }));
    expect(html).toContain('lc-to--direct');
    expect(html).not.toContain('lc-to--eligible');
    expect(html).not.toContain('>or<');
  });

  it('treats a one-name set as a team act, not a set of one', () => {
    // A single-name "set" is a member act that took the wrong road; naming it would assert a
    // routing fact the ledger does not have.
    const html = render(env({ meta: { eligible: ['ryder'] } }));
    expect(html).toContain('lc-to--team');
    expect(html).not.toContain('lc-to--eligible');
  });
});
