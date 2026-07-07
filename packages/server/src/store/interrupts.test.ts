import { PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { pendingInterrupts } from './messages.js';

/**
 * The pure interrupt-class predicate behind `inbox --interrupt-check` (ADR 088). Interrupt-class =
 * directed-at-me-or-request_help + not-resolved + (urgent OR a `steer`) — ADR 102 makes a `steer`
 * interrupt-class by definition (it raises the line without the urgent flag), while `challenge`/`defer`
 * stay behind the urgent gate. The newest steer supersedes prior steers so a late agent sees one
 * direction. Newest first. Tested in isolation because the whole "scarce by construction" property
 * (and the supersession collapse) lives here.
 */
describe('pendingInterrupts (ADR 088)', () => {
  const env = (
    over: Partial<Envelope> & Pick<Envelope, 'id' | 'from' | 'to' | 'act'>,
  ): Envelope => ({
    v: PROTOCOL_VERSION,
    team: 'dawn',
    body: 'x',
    thread: null,
    meta: null,
    ts: 1,
    ...over,
  });
  const urgent = { urgent: true, urgent_reason: 'prod is down' };
  const toMe = { kind: 'member' as const, name: 'me' };

  it('raises an urgent directed act and an urgent request_help', () => {
    const msgs = [
      env({ id: 'a', from: 'nick', to: toMe, act: 'handoff', meta: urgent }),
      env({ id: 'b', from: 'jo', to: { kind: 'team' }, act: 'request_help', meta: urgent }),
    ];
    expect(
      pendingInterrupts(msgs, 'me')
        .map((m) => m.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('ignores a non-urgent act, a broadcast status_update, my own echo, and an act for someone else', () => {
    const msgs = [
      env({ id: 'plain', from: 'nick', to: toMe, act: 'handoff' }), // directed but not urgent
      env({ id: 'journal', from: 'jo', to: { kind: 'team' }, act: 'status_update', meta: urgent }), // urgent but not action-needed
      env({ id: 'mine', from: 'me', to: toMe, act: 'handoff', meta: urgent }), // my own send
      env({
        id: 'other',
        from: 'nick',
        to: { kind: 'member', name: 'you' },
        act: 'handoff',
        meta: urgent,
      }),
    ];
    expect(pendingInterrupts(msgs, 'me')).toEqual([]);
  });

  it('stops raising once the thread is resolved (a terminal resolve never interrupts)', () => {
    const msgs = [
      env({ id: 'ask', from: 'nick', to: toMe, act: 'request_help', meta: urgent, thread: 'ask' }),
      env({
        id: 'done',
        from: 'me',
        to: { kind: 'team' },
        act: 'resolve',
        thread: 'ask',
        meta: urgent,
      }),
    ];
    expect(pendingInterrupts(msgs, 'me')).toEqual([]);
  });

  it('returns newest first so the caller names the most recent steer', () => {
    const msgs = [
      env({ id: 'old', from: 'nick', to: toMe, act: 'handoff', meta: urgent, ts: 10 }),
      env({ id: 'new', from: 'jo', to: toMe, act: 'handoff', meta: urgent, ts: 20 }),
    ];
    expect(pendingInterrupts(msgs, 'me').map((m) => m.id)).toEqual(['new', 'old']);
  });

  // ADR 102 — the steering acts.
  it('raises a steer even when it is not flagged urgent (steer is interrupt-class by definition)', () => {
    const msgs = [env({ id: 's', from: 'nick', to: toMe, act: 'steer', body: 'use v2' })];
    expect(pendingInterrupts(msgs, 'me').map((m) => m.id)).toEqual(['s']);
  });

  it('does NOT raise a non-urgent challenge or defer (tier-configurable — they ride the urgent gate)', () => {
    const msgs = [
      env({ id: 'c', from: 'nick', to: toMe, act: 'challenge', body: 'why?' }),
      env({ id: 'd', from: 'nick', to: toMe, act: 'defer', meta: { goal_id: 'g1' } }),
    ];
    expect(pendingInterrupts(msgs, 'me')).toEqual([]);
  });

  it('raises a challenge and a defer when their sender flags them urgent', () => {
    const msgs = [
      env({ id: 'c', from: 'nick', to: toMe, act: 'challenge', meta: urgent }),
      env({ id: 'd', from: 'jo', to: toMe, act: 'defer', meta: { ...urgent, goal_id: 'g1' } }),
    ];
    expect(
      pendingInterrupts(msgs, 'me')
        .map((m) => m.id)
        .sort(),
    ).toEqual(['c', 'd']);
  });

  it('supersedes prior steers: only the newest steer survives, a late agent sees one direction', () => {
    const msgs = [
      env({ id: 's1', from: 'nick', to: toMe, act: 'steer', body: 'plan A', ts: 10 }),
      env({ id: 's2', from: 'jo', to: toMe, act: 'steer', body: 'plan B', ts: 20 }),
      env({ id: 's3', from: 'nick', to: toMe, act: 'steer', body: 'plan C', ts: 30 }),
    ];
    expect(pendingInterrupts(msgs, 'me').map((m) => m.id)).toEqual(['s3']);
  });

  it('a superseding steer does not swallow an unrelated urgent handoff still waiting', () => {
    const msgs = [
      env({ id: 'h', from: 'jo', to: toMe, act: 'handoff', meta: urgent, ts: 5 }),
      env({ id: 's1', from: 'nick', to: toMe, act: 'steer', ts: 10 }),
      env({ id: 's2', from: 'nick', to: toMe, act: 'steer', ts: 20 }),
    ];
    expect(pendingInterrupts(msgs, 'me').map((m) => m.id)).toEqual(['s2', 'h']);
  });

  it('a resolve on a steer thread closes it (a steer is not immune to resolution)', () => {
    const msgs = [
      env({ id: 's', from: 'nick', to: toMe, act: 'steer', thread: 's', ts: 10 }),
      env({ id: 'done', from: 'me', to: { kind: 'team' }, act: 'resolve', thread: 's', ts: 20 }),
    ];
    expect(pendingInterrupts(msgs, 'me')).toEqual([]);
  });

  it('resolving the current steer does NOT revive an older superseded steer (Bugbot: revive bug)', () => {
    const msgs = [
      env({ id: 's1', from: 'nick', to: toMe, act: 'steer', thread: 's1', ts: 10 }),
      env({ id: 's2', from: 'jo', to: toMe, act: 'steer', thread: 's2', ts: 20 }),
      env({ id: 'done', from: 'me', to: { kind: 'team' }, act: 'resolve', thread: 's2', ts: 30 }),
    ];
    // s2 (newest) supersedes s1 and is then resolved — nothing should interrupt (s1 stays dead).
    expect(pendingInterrupts(msgs, 'me')).toEqual([]);
  });

  it('the newest steer still fires when an OLDER steer thread was resolved', () => {
    const msgs = [
      env({ id: 's1', from: 'nick', to: toMe, act: 'steer', thread: 's1', ts: 10 }),
      env({ id: 'done', from: 'me', to: { kind: 'team' }, act: 'resolve', thread: 's1', ts: 15 }),
      env({ id: 's2', from: 'jo', to: toMe, act: 'steer', thread: 's2', ts: 20 }),
    ];
    expect(pendingInterrupts(msgs, 'me').map((m) => m.id)).toEqual(['s2']);
  });
});
