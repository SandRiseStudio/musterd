import { ASK_TIER_DEFAULTS, PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { askIsLoud, byUrgency, deriveAsks } from './asks';

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

    // ADR 153: a strand closes quietly — the seat freed itself, the released lane carries the WIP.
    const stranded = deriveAsks([
      ask('a3', 1000, 'blocking'),
      env('s3', 'status_update', { ts: 2000, meta: { ask_ref: 'a3', ask_outcome: 'stranded' } }),
    ]);
    expect(stranded[0]!.state).toBe('stranded');
    expect(askIsLoud('stranded')).toBe(false);
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

describe('byUrgency — which ask the rail leads with', () => {
  const view = (
    tier: 'advisory' | 'standard' | 'blocking',
    deadline: number,
    state: 'open' | 'held' = 'open',
  ) => ({ tier, deadline, state }) as unknown as Parameters<typeof byUrgency>[0];

  const NOW = 1_000_000;

  it('puts a held ask above everything — nothing is moving until a human answers', () => {
    const held = view('standard', NOW - 1, 'held');
    const live = view('blocking', NOW + 60_000);
    expect([live, held].sort((a, b) => byUrgency(a, b, NOW))[0]).toBe(held);
  });

  it('treats an elapsed BLOCKING ask as stuck — its tier holds', () => {
    const elapsed = view('blocking', NOW - 1);
    const live = view('blocking', NOW + 60_000);
    expect([live, elapsed].sort((a, b) => byUrgency(a, b, NOW))[0]).toBe(elapsed);
  });

  it('does NOT treat an elapsed STANDARD ask as stuck — that agent proceeded', () => {
    // The regression this exists for: ranking by "clock ran out" alone put a decision already made
    // above one still waiting to be made.
    const elapsedStandard = view('standard', NOW - 1);
    const liveBlocking = view('blocking', NOW + 60_000);
    expect([elapsedStandard, liveBlocking].sort((a, b) => byUrgency(a, b, NOW))[0]).toBe(
      liveBlocking,
    );
  });

  it('ranks by tier before clock — a blocking ask outranks a sooner advisory one', () => {
    const advisorySoon = view('advisory', NOW + 5_000);
    const blockingLater = view('blocking', NOW + 600_000);
    expect([advisorySoon, blockingLater].sort((a, b) => byUrgency(a, b, NOW))[0]).toBe(
      blockingLater,
    );
  });

  it('falls back to the soonest deadline within a tier', () => {
    const later = view('standard', NOW + 90_000);
    const sooner = view('standard', NOW + 30_000);
    expect([later, sooner].sort((a, b) => byUrgency(a, b, NOW))[0]).toBe(sooner);
  });
});
