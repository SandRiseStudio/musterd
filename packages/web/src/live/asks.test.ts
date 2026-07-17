import { ASK_TIER_DEFAULTS, PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { askIsLoud, deriveAsks } from './asks';

/** A minimal timeline envelope — the derivation reads act/meta/thread/ts/id/from only. */
function env(
  id: string,
  act: Envelope['act'],
  opts: {
    from?: string;
    ts?: number;
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
    to: { kind: 'team' },
    act,
    body: opts.body ?? '',
    thread: opts.thread ?? null,
    meta: opts.meta ?? null,
    ts: opts.ts ?? 1000,
  } as Envelope;
}

const ask = (id: string, ts: number, tier = 'standard', species = 'consult') =>
  env(id, 'ask', { ts, meta: { species, tier } });

describe('deriveAsks (ADR 149)', () => {
  it('derives an open ask with the tier deadline from the shared protocol constant', () => {
    const [a] = deriveAsks([ask('a1', 1000, 'blocking', 'escalate')]);
    expect(a).toMatchObject({ species: 'escalate', tier: 'blocking', state: 'open' });
    expect(a!.deadline).toBe(1000 + ASK_TIER_DEFAULTS.blocking.timeout_ms);
    expect(askIsLoud(a!.state)).toBe(true);
  });

  it('skips a malformed ask (missing species/tier) rather than inventing a contract', () => {
    expect(deriveAsks([env('bad', 'ask', { meta: { species: 'nope' } })])).toHaveLength(0);
  });

  it('an accept referencing the ask closes it (in_reply_to, thread, or ask_ref)', () => {
    const byReply = deriveAsks([
      ask('a1', 1000),
      env('r1', 'accept', { from: 'nick', ts: 2000, meta: { in_reply_to: 'a1' } }),
    ]);
    expect(byReply[0]).toMatchObject({ state: 'accepted', answeredBy: 'nick' });

    const byThread = deriveAsks([
      ask('a2', 1000),
      env('r2', 'decline', { from: 'nick', ts: 2000, thread: 'a2', meta: { in_reply_to: 'zz' } }),
    ]);
    expect(byThread[0]).toMatchObject({ state: 'declined', answeredBy: 'nick' });
  });

  it('the human "deciding — check back in ⟨until⟩" defers the ask (wait + ask_ref, ADR 147 §5)', () => {
    const [a] = deriveAsks([
      ask('a1', 1000),
      env('w1', 'wait', { from: 'nick', ts: 2000, meta: { ask_ref: 'a1', until: '1h' } }),
    ]);
    expect(a).toMatchObject({ state: 'deferred', answeredBy: 'nick', until: '1h' });
    expect(askIsLoud(a!.state)).toBe(false);
  });

  it('agent outcomes land: held stays loud, risk_accepted closes', () => {
    const held = deriveAsks([
      ask('a1', 1000, 'blocking'),
      env('s1', 'status_update', { ts: 2000, meta: { ask_ref: 'a1', ask_outcome: 'held' } }),
    ]);
    expect(held[0]!.state).toBe('held');
    expect(askIsLoud('held')).toBe(true);

    const risked = deriveAsks([
      ask('a2', 1000),
      env('s2', 'status_update', {
        ts: 2000,
        meta: { ask_ref: 'a2', ask_outcome: 'risk_accepted', risk: 'r', chosen_approach: 'c' },
      }),
    ]);
    expect(risked[0]!.state).toBe('risk_accepted');
  });

  it('a human answer is terminal — a later agent outcome cannot reopen or override it', () => {
    const [a] = deriveAsks([
      ask('a1', 1000),
      env('r1', 'accept', { from: 'nick', ts: 2000, meta: { in_reply_to: 'a1' } }),
      env('s1', 'status_update', {
        ts: 3000,
        meta: { ask_ref: 'a1', ask_outcome: 'risk_accepted', risk: 'r', chosen_approach: 'c' },
      }),
    ]);
    expect(a!.state).toBe('accepted');
  });

  it('a deferred ask can still be answered afterwards', () => {
    const [a] = deriveAsks([
      ask('a1', 1000),
      env('w1', 'wait', { from: 'nick', ts: 2000, meta: { ask_ref: 'a1', until: '1h' } }),
      env('r1', 'accept', { from: 'nick', ts: 3000, meta: { in_reply_to: 'a1' } }),
    ]);
    expect(a!.state).toBe('accepted');
  });

  it('sorts newest ask first and dedupes repeated envelope ids (backfill + firehose overlap)', () => {
    const twice = ask('a1', 1000);
    const views = deriveAsks([twice, twice, ask('a2', 5000)]);
    expect(views.map((v) => v.env.id)).toEqual(['a2', 'a1']);
  });

  it('a thread resolve closes an ask without an explicit answer act', () => {
    const [a] = deriveAsks([
      ask('a1', 1000),
      env('r1', 'resolve', { from: 'ada', ts: 2000, thread: 'a1' }),
    ]);
    expect(a!.state).toBe('resolved');
  });
});
