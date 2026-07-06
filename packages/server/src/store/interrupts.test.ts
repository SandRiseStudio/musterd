import { PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { pendingInterrupts } from './messages.js';

/**
 * The pure interrupt-class predicate behind `inbox --interrupt-check` (ADR 088). Interrupt-class =
 * directed-at-me-or-request_help + urgent (`meta.urgent`, only set once `can_flag_urgent` passed the
 * send gate) + not closed by a `resolve`. Newest first. Tested in isolation because the whole "scarce
 * by construction" property lives here.
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
});
