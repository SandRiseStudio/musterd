import { PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { deferrals, raisedDeferrals } from './messages.js';

/**
 * The pure deferral fold behind "raise this again later" (ADR 211). A deferring `wait`
 * (`meta.defer_ref` + `meta.until`) postpones one directed act; the condition that ends the
 * postponement is a state edge, never a clock (ADR 179 — the daemon runs no clocks). Tested in
 * isolation, like `pendingInterrupts`, because the latest-wins collapse and the raise predicate are
 * the whole primitive: everything downstream just reads what these two functions derive.
 */
const env = (over: Partial<Envelope> & Pick<Envelope, 'id' | 'from' | 'act'>): Envelope => ({
  v: PROTOCOL_VERSION,
  team: 'dawn',
  to: { kind: 'team' },
  body: 'x',
  thread: null,
  meta: null,
  ts: 1,
  ...over,
});

const toMe = { kind: 'member' as const, name: 'me' };
/** the ask `me` received and will postpone — the target of every deferral below */
const ask = env({ id: 'a1', from: 'stanley', to: toMe, act: 'ask', ts: 100 });
const deferUntil = (id: string, ts: number, until: unknown) =>
  env({ id, from: 'me', act: 'wait', ts, meta: { defer_ref: 'a1', until } });

describe('deferrals (ADR 211 §3)', () => {
  it('folds a deferring wait onto the act it postpones', () => {
    const held = deferrals([ask, deferUntil('w1', 200, { reply: true })], 'me');
    expect(held.get('a1')).toEqual({
      target: 'a1',
      by: 'w1',
      ts: 200,
      until: { reply: true },
    });
  });

  it('takes the newest wait per target — re-deferring supersedes, no supersede column', () => {
    const held = deferrals(
      [ask, deferUntil('w1', 200, { reply: true }), deferUntil('w2', 300, { lane: 'L1' })],
      'me',
    );
    expect(held.get('a1')).toMatchObject({ by: 'w2', until: { lane: 'L1' } });
  });

  it('breaks a ts tie on id, so the fold is deterministic', () => {
    const held = deferrals(
      [ask, deferUntil('w2', 200, { lane: 'L1' }), deferUntil('w1', 200, { reply: true })],
      'me',
    );
    expect(held.get('a1')).toMatchObject({ by: 'w2', until: { lane: 'L1' } });
  });

  it('ignores a wait authored by someone else — only the recipient may defer', () => {
    const theirs = env({
      id: 'w1',
      from: 'izzo',
      act: 'wait',
      ts: 200,
      meta: { defer_ref: 'a1', until: { reply: true } },
    });
    expect(deferrals([ask, theirs], 'me').size).toBe(0);
  });

  it('ignores a bare wait, a deciding wait, and a malformed condition', () => {
    const msgs = [
      ask,
      env({ id: 'w1', from: 'me', act: 'wait', ts: 200 }),
      env({ id: 'w2', from: 'me', act: 'wait', ts: 210, meta: { ask_ref: 'a1', until: '1h' } }),
      deferUntil('w3', 220, { at: 1785790000000 }),
      deferUntil('w4', 230, '1h'),
    ];
    expect(deferrals(msgs, 'me').size).toBe(0);
  });
});

describe('raisedDeferrals (ADR 211 §2)', () => {
  it('does not raise while nothing has happened', () => {
    expect(raisedDeferrals([ask, deferUntil('w1', 200, { reply: true })], 'me').size).toBe(0);
  });

  it('raises on a reply from someone else after the wait', () => {
    const msgs = [
      ask,
      deferUntil('w1', 200, { reply: true }),
      env({ id: 'm1', from: 'stanley', act: 'message', ts: 300, thread: 'a1' }),
    ];
    expect(raisedDeferrals(msgs, 'me').has('a1')).toBe(true);
  });

  it('does not raise on my own act in the thread — I am not the reply I waited for', () => {
    const msgs = [
      ask,
      deferUntil('w1', 200, { reply: true }),
      env({ id: 'm1', from: 'me', act: 'message', ts: 300, thread: 'a1' }),
    ];
    expect(raisedDeferrals(msgs, 'me').has('a1')).toBe(false);
  });

  it('does not raise on a reply that predates the wait', () => {
    const msgs = [
      ask,
      env({ id: 'm1', from: 'stanley', act: 'message', ts: 150, thread: 'a1' }),
      deferUntil('w1', 200, { reply: true }),
    ];
    expect(raisedDeferrals(msgs, 'me').has('a1')).toBe(false);
  });

  it('does not raise on a reply to a DIFFERENT thread', () => {
    const msgs = [
      ask,
      deferUntil('w1', 200, { reply: true }),
      env({ id: 'm1', from: 'stanley', act: 'message', ts: 300, thread: 'other' }),
    ];
    expect(raisedDeferrals(msgs, 'me').has('a1')).toBe(false);
  });

  // Deliberately loose (ADR 211 §2): the first lane-state act wins, whatever state it names. A
  // target state would be more precise and more to get wrong; evidence can argue for it later.
  it('raises on the first lane-state act after the wait, whatever the state', () => {
    const msgs = [
      ask,
      deferUntil('w1', 200, { lane: 'L1' }),
      env({
        id: 'l1',
        from: 'izzo',
        act: 'message',
        ts: 300,
        meta: { lane_state: { lane: 'L1', state: 'active' } },
      }),
    ];
    expect(raisedDeferrals(msgs, 'me').has('a1')).toBe(true);
  });

  it('does not raise on a different lane moving', () => {
    const msgs = [
      ask,
      deferUntil('w1', 200, { lane: 'L1' }),
      env({
        id: 'l1',
        from: 'izzo',
        act: 'message',
        ts: 300,
        meta: { lane_state: { lane: 'L2', state: 'done' } },
      }),
    ];
    expect(raisedDeferrals(msgs, 'me').has('a1')).toBe(false);
  });

  it('never raises a target whose thread was resolved — the work it postponed is over', () => {
    const msgs = [
      ask,
      deferUntil('w1', 200, { reply: true }),
      env({ id: 'r1', from: 'me', act: 'resolve', ts: 250, thread: 'a1' }),
      env({ id: 'm1', from: 'stanley', act: 'message', ts: 300, thread: 'a1' }),
    ];
    expect(raisedDeferrals(msgs, 'me').has('a1')).toBe(false);
  });

  it('measures the condition against the NEWEST wait, not the first', () => {
    // A reply lands between the two deferrals: it is after w1 but before w2, so re-deferring
    // genuinely re-postpones rather than leaving a raise latched from the superseded wait.
    const msgs = [
      ask,
      deferUntil('w1', 200, { reply: true }),
      env({ id: 'm1', from: 'stanley', act: 'message', ts: 250, thread: 'a1' }),
      deferUntil('w2', 300, { reply: true }),
    ];
    expect(raisedDeferrals(msgs, 'me').has('a1')).toBe(false);
  });
});
