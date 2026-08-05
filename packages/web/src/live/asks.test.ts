import { ASK_TIER_DEFAULTS, PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  answerableCount,
  askAudience,
  askIsLoud,
  byAudienceThenUrgency,
  byUrgency,
  deriveAsks,
  deriveReviewQueue,
  reelItems,
} from './asks';

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
    to?: Envelope['to'];
  } = {},
): Envelope {
  return {
    id,
    v: PROTOCOL_VERSION,
    team: 'dawn',
    from: opts.from ?? 'ada',
    to: opts.to ?? { kind: 'team' },
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

/**
 * The strip named the wrong acceptor (lane 01KZ9GFHZ9), and it did it by never reading `to` at all.
 * ADR 149 was written when every `ask` was a to-human ask; ADR 191's review-loop wake now routes
 * acceptance asks to AGENT seats, so most of the timeline's asks are agent→agent. Rendering them
 * under copy that says "waiting on a human", beside a "Sign in as nick to answer" button, is how a
 * reader (me, 2026-08-05) concluded nick was holding ten asks the ledger had routed to gptbot.
 *
 * So the derivation carries the recipient, and audience is a first-class question.
 */
describe('the recipient — who an ask actually waits on', () => {
  const to = (name: string) => ({ kind: 'member', name }) as Envelope['to'];
  const humans = new Set(['nick']);

  it('carries the addressed member through the derivation', () => {
    const [a] = deriveAsks([
      env('a1', 'ask', { ts: 1000, meta: { species: 'approve', tier: 'standard' }, to: to('gptbot') }),
    ]);
    expect(a!.to).toBe('gptbot');
  });

  it('reads a team/broadcast ask as addressed to nobody in particular', () => {
    const [a] = deriveAsks([env('a1', 'ask', { ts: 1000, meta: { species: 'consult', tier: 'standard' } })]);
    expect(a!.to).toBeNull();
    expect(askAudience(a!, { you: 'nick', humans })).toBe('team');
  });

  it('separates YOU from another human from an agent — the distinction the strip erased', () => {
    const mk = (id: string, name: string) =>
      deriveAsks([
        env(id, 'ask', { ts: 1000, meta: { species: 'approve', tier: 'standard' }, to: to(name) }),
      ])[0]!;
    expect(askAudience(mk('a1', 'nick'), { you: 'nick', humans })).toBe('you');
    expect(askAudience(mk('a2', 'nick'), { you: 'miley', humans })).toBe('human');
    expect(askAudience(mk('a3', 'gptbot'), { you: 'nick', humans })).toBe('agent');
  });

  it('an agent-routed ask is not yours even when you are the one who is signed in', () => {
    // The exact false reading: signed in as nick, looking at izzo's ask routed to gptbot.
    const [a] = deriveAsks([
      env('a1', 'ask', {
        from: 'izzo',
        ts: 1000,
        meta: { species: 'approve', tier: 'standard' },
        to: to('gptbot'),
      }),
    ]);
    expect(askAudience(a!, { you: 'nick', humans })).toBe('agent');
  });
});

describe('byAudienceThenUrgency — the rail leads with what is actually yours', () => {
  const humans = new Set(['nick']);
  const mk = (id: string, name: string, ts: number) =>
    deriveAsks([
      env(id, 'ask', {
        ts,
        meta: { species: 'approve', tier: 'standard' },
        to: { kind: 'member', name } as Envelope['to'],
      }),
    ])[0]!;

  it('puts an ask routed to you ahead of an older, more urgent one routed to an agent', () => {
    const mine = mk('a1', 'nick', 5000);
    const theirs = mk('a2', 'gptbot', 1000);
    const sorted = [theirs, mine].sort(byAudienceThenUrgency({ you: 'nick', humans }));
    expect(sorted.map((a) => a.env.id)).toEqual(['a1', 'a2']);
  });

  it('falls back to urgency within the same audience — the ADR 149 order is untouched', () => {
    const older = mk('a1', 'gptbot', 1000);
    const newer = mk('a2', 'gptbot', 5000);
    const sorted = [newer, older].sort(byAudienceThenUrgency({ you: 'nick', humans }));
    expect(sorted.map((a) => a.env.id)).toEqual(['a1', 'a2']);
  });
});

/**
 * The review queue (nick, 2026-08-05): every lane sitting in acceptance, and who it waits on. The
 * board overlay has this buried a click away; the founder asked for it at a glance beside the asks.
 * `waitingOn` joins the lane to its routed acceptance ask by `meta.lane_review.lane` — the daemon
 * stamps that on every ADR 191 review ask, so the join is by id, never by title-string matching.
 */
describe('deriveReviewQueue — lanes in acceptance and who they wait on', () => {
  const lane = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    state: 'awaiting_acceptance',
    title: `lane ${id}`,
    owner_seat: 'miley',
    updated_at: 1000,
    ...over,
  });
  const reviewAsk = (id: string, laneId: string, to: string, ts = 2000) =>
    env(id, 'ask', {
      ts,
      meta: { species: 'approve', tier: 'standard', lane_review: { lane: laneId } },
      to: { kind: 'member', name: to } as Envelope['to'],
    });

  it('keeps only lanes in acceptance (both state spellings) and joins the routed acceptor', () => {
    const asks = deriveAsks([reviewAsk('r1', 'L1', 'gptbot')]);
    const queue = deriveReviewQueue(
      [
        lane('L1'),
        lane('L2', { state: 'ready_for_review' }),
        lane('L3', { state: 'active' }),
        lane('L4', { state: 'done' }),
      ] as never[],
      asks,
    );
    expect(queue.map((r) => r.lane.id)).toEqual(['L1', 'L2']);
    expect(queue[0]!.waitingOn).toBe('gptbot');
    expect(queue[1]!.waitingOn).toBeNull(); // no routed ask found — say "unrouted", never guess
  });

  it('longest-waiting first, and a later re-route supersedes the earlier acceptor', () => {
    const asks = deriveAsks([
      reviewAsk('r1', 'L1', 'izzo', 2000),
      reviewAsk('r2', 'L1', 'gptbot', 3000),
    ]);
    const queue = deriveReviewQueue(
      [lane('L1', { updated_at: 5000 }), lane('L2', { updated_at: 1000 })] as never[],
      asks,
    );
    expect(queue.map((r) => r.lane.id)).toEqual(['L2', 'L1']);
    expect(queue[1]!.waitingOn).toBe('gptbot');
  });

  it('an answered review ask stops naming the acceptor as waited-on', () => {
    const asks = deriveAsks([
      reviewAsk('r1', 'L1', 'gptbot'),
      env('acc', 'accept', { from: 'gptbot', ts: 3000, meta: { in_reply_to: 'r1' } }),
    ]);
    const queue = deriveReviewQueue([lane('L1')] as never[], asks);
    expect(queue[0]!.waitingOn).toBeNull();
  });
});

/**
 * The stream's rotation (nick, 2026-08-05: "can a viewer see the acceptances waiting on other
 * members?"). On /live the review queue sits in a sheet behind a click; a broadcast viewer can never
 * click, so the reel must ROTATE lanes-in-review alongside asks or they are invisible on the stream.
 */
describe('reelItems — what the stream rotates through', () => {
  const to = (name: string) => ({ kind: 'member', name }) as Envelope['to'];
  const lane = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    state: 'awaiting_acceptance',
    title: `lane ${id}`,
    owner_seat: 'miley',
    updated_at: 1000,
    ...over,
  });

  it('rotates loud asks first, then lanes in review — and never a lane twice', () => {
    const asks = deriveAsks([
      env('a1', 'ask', {
        ts: 1000,
        meta: { species: 'approve', tier: 'standard', lane_review: { lane: 'L1' } },
        to: to('gptbot'),
      }),
    ]);
    const items = reelItems(asks, deriveReviewQueue([lane('L1'), lane('L2')] as never[], asks));
    expect(items.map((i) => i.kind)).toEqual(['ask', 'review']);
    // L1's ask is already rotating as an ask; showing its lane too would double-count it.
    expect(items.filter((i) => i.kind === 'review').map((i) => i.review!.lane.id)).toEqual(['L2']);
  });

  it('shows a lane whose acceptance ask was answered but whose lane is still open', () => {
    const asks = deriveAsks([
      env('a1', 'ask', {
        ts: 1000,
        meta: { species: 'approve', tier: 'standard', lane_review: { lane: 'L1' } },
        to: to('gptbot'),
      }),
      env('acc', 'accept', { from: 'gptbot', ts: 2000, meta: { in_reply_to: 'a1' } }),
    ]);
    const items = reelItems(asks, deriveReviewQueue([lane('L1')] as never[], asks));
    expect(items.map((i) => i.kind)).toEqual(['review']);
    expect(items[0]!.review!.waitingOn).toBeNull();
  });

  it('is empty when nothing is waiting anywhere', () => {
    expect(reelItems([], [])).toEqual([]);
  });
});

/**
 * ryder's review note on #687: the tab title counted `team`-audience asks even when this browser has
 * no identity at all, so a watch-link viewer who has never signed in and cannot answer anything still
 * read "(3 asks)" in their tab. Smaller than the ten-asks lie that opened lane 01KZ9GFHZ9, but the
 * same species — a count addressed to somebody it is not addressed to.
 *
 * The line is `ctx.you`: a browser one click from being nick still counts (the title is the nudge,
 * and the team pool is genuinely takeable), but a browser that is nobody counts nothing.
 */
describe('answerableCount — the tab title only counts asks THIS browser could answer', () => {
  const to = (name: string) => ({ kind: 'member', name }) as Envelope['to'];
  const humans = new Set(['nick']);
  const mk = (id: string, recipient?: string) =>
    deriveAsks([
      env(id, 'ask', {
        ts: 1000,
        meta: { species: 'approve', tier: 'standard' },
        ...(recipient ? { to: to(recipient) } : {}),
      }),
    ])[0]!;

  it('counts nothing for a viewer with no identity — even when team-pool asks are open', () => {
    const pool = [mk('a1'), mk('a2'), mk('a3')]; // to: team → audience 'team'
    expect(answerableCount(pool, { you: null, humans })).toBe(0);
  });

  it('counts team-pool asks for a browser that is one click from an identity', () => {
    expect(answerableCount([mk('a1'), mk('a2')], { you: 'nick', humans })).toBe(2);
  });

  it('counts yours, and never an agent-routed review', () => {
    const mine = mk('a1', 'nick');
    const theirs = mk('a2', 'gptbot');
    expect(answerableCount([mine, theirs], { you: 'nick', humans })).toBe(1);
  });

  it('counts nothing when every open ask is routed to an agent', () => {
    expect(answerableCount([mk('a1', 'gptbot'), mk('a2', 'izzo')], { you: 'nick', humans })).toBe(0);
  });
});
