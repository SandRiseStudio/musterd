import { PROTOCOL_VERSION, type Envelope, type MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { newRings, openRingsFor, ringNotice } from './doorbellNotify';

function env(
  id: string,
  act: Envelope['act'],
  opts: {
    from?: string;
    to?: Envelope['to'];
    thread?: string | null;
    meta?: Record<string, unknown> | null;
    body?: string;
  } = {},
): Envelope {
  return {
    id,
    v: PROTOCOL_VERSION,
    team: 'dawn',
    from: opts.from ?? 'ada',
    to: opts.to ?? { kind: 'team' },
    act,
    body: opts.body ?? 'the secret plan',
    thread: opts.thread ?? null,
    meta: opts.meta ?? null,
    ts: 1000,
  } as Envelope;
}

const member = (name: string, kind: 'human' | 'agent', admin = false) =>
  ({ name, kind, capabilities: { is_admin: admin } }) as unknown as MemberSummary;
const roster = [member('nick', 'human', true), member('dee', 'human'), member('ada', 'agent')];
const toMember = (name: string) => ({ kind: 'member', name }) as Envelope['to'];
const consult = { species: 'consult', tier: 'standard' };

describe('openRingsFor — the live sink rings the connected seat (ADR 443)', () => {
  it('a directed ask, handoff or request_help to you rings you', () => {
    const tl = [
      env('a1', 'ask', { to: toMember('dee'), meta: consult }),
      env('h1', 'handoff', { to: toMember('dee') }),
      env('r1', 'request_help', { to: toMember('dee') }),
      env('m1', 'message', { to: toMember('dee') }),
    ];
    expect(openRingsFor(tl, roster, 'dee').map((e) => e.id)).toEqual(['a1', 'h1', 'r1']);
  });

  it('a team ask rings the admin, not every human', () => {
    const tl = [env('a1', 'ask', { meta: consult })];
    expect(openRingsFor(tl, roster, 'nick').map((e) => e.id)).toEqual(['a1']);
    expect(openRingsFor(tl, roster, 'dee')).toEqual([]);
  });

  it('an answered or resolved act no longer rings', () => {
    const tl = [
      env('a1', 'ask', { to: toMember('dee'), meta: consult }),
      env('a2', 'accept', { from: 'dee', to: toMember('ada'), meta: { in_reply_to: 'a1' } }),
      env('h1', 'handoff', { to: toMember('dee') }),
      env('h2', 'resolve', { to: toMember('dee'), thread: 'h1' }),
    ];
    expect(openRingsFor(tl, roster, 'dee')).toEqual([]);
  });

  it('an observer, a watch link or a signed-out tab is never rung', () => {
    const tl = [env('a1', 'ask', { meta: consult })];
    expect(openRingsFor(tl, roster, null)).toEqual([]);
    expect(openRingsFor(tl, roster, 'observer-7')).toEqual([]);
  });

  it('an agent seat is never rung', () =>
    expect(openRingsFor([env('h1', 'handoff', { to: toMember('ada') })], roster, 'ada')).toEqual(
      [],
    ));
});

describe('newRings — once, and never for the backfill', () => {
  const tl = [env('a1', 'ask', { to: toMember('dee'), meta: consult })];

  it('an act from the backfill never fires, whatever its timestamp', () =>
    expect(newRings(openRingsFor(tl, roster, 'dee'), new Set(), new Set())).toEqual([]));

  it('a ring that arrived live fires once', () => {
    const seen = new Set<string>();
    const live = new Set(['a1']);
    const first = newRings(openRingsFor(tl, roster, 'dee'), seen, live);
    expect(first.map((e) => e.id)).toEqual(['a1']);
    for (const e of first) seen.add(e.id);
    expect(newRings(openRingsFor(tl, roster, 'dee'), seen, live)).toEqual([]);
  });

  it('does not compare clocks: a live act stamped long before now still fires', () => {
    const old = [{ ...env('a2', 'ask', { to: toMember('dee'), meta: consult }), ts: 0 }];
    expect(newRings(openRingsFor(old, roster, 'dee'), new Set(), new Set(['a2']))).toHaveLength(1);
  });
});

describe('ringNotice — who and what, never the body', () => {
  it.each([
    [env('a', 'ask', { meta: { species: 'approve', tier: 'blocking' } }), 'ada needs your approval (blocking)'],
    [env('a', 'ask', { meta: null }), 'ada asks what you think'],
    [env('h', 'handoff'), 'ada handed you work'],
    [env('r', 'request_help'), 'ada needs your help'],
  ])('%#', (e, body) => {
    const notice = ringNotice(e);
    expect(notice).toEqual({ id: e.id, title: 'musterd [dawn]', body });
    expect(JSON.stringify(notice)).not.toContain('secret plan');
  });
});
