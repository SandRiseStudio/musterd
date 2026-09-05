import { PROTOCOL_VERSION, type Envelope, type MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HuddleRail } from './HuddleRail';

/**
 * The huddle rail, rendered (ADR 378 increment 2). Server-rendered markup, no jsdom and no
 * testing-library — the package's standing choice (see `AsksStrip.render.test.ts`).
 *
 * What these hold is the *claim the surface makes*: a huddle that has run past what it declared is
 * still shown, still open, and says so. A test that let it disappear would let the page enforce a
 * budget the daemon deliberately does not.
 */
const roster = [
  { name: 'nick', kind: 'human' },
  { name: 'izzo', kind: 'agent' },
  { name: 'miley', kind: 'agent' },
] as unknown as MemberSummary[];

const NOW = 1_000_000;

const env = (
  id: string,
  over: Partial<Envelope> & { meta?: Record<string, unknown> | null } = {},
): Envelope =>
  ({
    id,
    v: PROTOCOL_VERSION,
    team: 'revive',
    from: 'izzo',
    to: { kind: 'team' },
    act: 'message',
    body: '',
    thread: null,
    meta: null,
    ts: NOW - 60_000,
    ...over,
  }) as Envelope;

const huddle = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) =>
  env('01root', {
    body: 'the asks rail arc — ring or bar?',
    meta: {
      huddle: {
        topic: { kind: 'lane', id: '01LANE7' },
        room: 'http://127.0.0.1:4851/b/huddle-01root',
        anchor: 'docs/design/asks-rail.md',
        ...over,
      },
      ...meta,
    },
  });

const turn = (id: string, from: string) =>
  env(id, { from, thread: '01root', body: 'a turn', ts: NOW - 30_000 });

const html = (envelopes: Envelope[], props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(HuddleRail, { envelopes, roster, now: NOW, ...props } as never));

describe('HuddleRail', () => {
  it('renders nothing when no huddle is open', () => {
    expect(html([env('01x', { act: 'status_update' })])).toBe('');
  });

  it('renders nothing once the huddle has resolved — the room emptied', () => {
    expect(
      html([huddle(), env('01c', { act: 'resolve', thread: '01root', meta: { anchor_ref: 'x@1' } })]),
    ).toBe('');
  });

  it('names the topic and the line the huddle opened on', () => {
    const out = html([huddle()]);
    expect(out).toContain('01LANE7');
    expect(out).toContain('the asks rail arc');
  });

  it('shows who is gathered and who was named but has not spoken', () => {
    const out = html([
      huddle({}, { eligible: ['miley', 'nick'] }),
      turn('01t1', 'miley'),
    ]);
    expect(out).toContain('izzo');
    expect(out).toContain('miley');
    expect(out).toMatch(/nick[\s\S]*yet to speak|yet to speak[\s\S]*nick/);
  });

  it('counts the turns taken against the turns declared', () => {
    const out = html([huddle({ budget: { turns: 6 } }), turn('01t1', 'miley'), turn('01t2', 'nick')]);
    expect(out).toContain('2 of 6 turns');
  });

  it('keeps an over-budget huddle on the rail and says it is over', () => {
    const out = html([
      huddle({ budget: { turns: 1 } }),
      turn('01t1', 'miley'),
      turn('01t2', 'nick'),
    ]);
    expect(out).toContain('2 of 1 turns');
    expect(out).toContain('over');
  });

  it('says the declared end has passed without closing anything', () => {
    const out = html([huddle({ budget: { until: NOW - 60_000 } })]);
    expect(out).toContain('over');
  });

  it('links out to the room — a link, never a socket', () => {
    const out = html([huddle()]);
    expect(out).toContain('href="http://127.0.0.1:4851/b/huddle-01root"');
    expect(out).toContain('target="_blank"');
  });

  it('drops the link on a stream, where nobody can click it', () => {
    const out = html([huddle()], { roomLink: false });
    expect(out).not.toContain('<a ');
    expect(out).toContain('01LANE7');
  });

  it('names the anchor — where the huddle says its output will land', () => {
    expect(html([huddle()])).toContain('docs/design/asks-rail.md');
  });
});
