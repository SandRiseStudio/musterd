import type { Act, Envelope, Recipient } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { actToEvent } from './mapping';

function env(act: Act, over: Partial<Envelope> = {}): Envelope {
  return {
    id: 'e1',
    v: 'musterd/0.3',
    team: 'ritual',
    from: 'ada',
    to: { kind: 'member', name: 'ben' } as Recipient,
    act,
    body: '',
    thread: null,
    meta: null,
    ts: 0,
    ...over,
  } as Envelope;
}

describe('actToEvent', () => {
  it('maps status_update to an ambient screen pulse at the sender', () => {
    expect(actToEvent(env('status_update'))).toEqual({
      kind: 'screen-pulse',
      who: 'ada',
      tone: 'status',
    });
  });

  it('maps a direct message to a note, a team message to a megaphone', () => {
    expect(actToEvent(env('message'))).toMatchObject({ kind: 'note', from: 'ada', to: 'ben' });
    expect(actToEvent(env('message', { to: { kind: 'team' } }))).toEqual({
      kind: 'megaphone',
      from: 'ada',
    });
  });

  it('maps request_help to a walk-over, escalating to urgent on meta.urgent', () => {
    expect(actToEvent(env('request_help'))).toMatchObject({ kind: 'walk-help', tier: 'needs-attn' });
    expect(
      actToEvent(env('request_help', { meta: { urgent: true, urgent_reason: 'prod down' } })),
    ).toMatchObject({ kind: 'walk-help', tier: 'urgent' });
    expect(actToEvent(env('request_help', { to: { kind: 'broadcast' } }))).toMatchObject({
      kind: 'megaphone',
    });
  });

  it('maps handoff to a carry-box with a truncated label', () => {
    const e = actToEvent(env('handoff', { body: 'the auth refactor branch is ready to take over now' }));
    expect(e).toMatchObject({ kind: 'walk-handoff', from: 'ada', to: 'ben' });
    if (e && e.kind === 'walk-handoff') expect(e.label.length).toBeLessThanOrEqual(24);
  });

  it('maps accept/decline/wait/resolve to sender-anchored cues', () => {
    expect(actToEvent(env('accept', { meta: { in_reply_to: 'x' } }))).toEqual({ kind: 'accept', who: 'ada' });
    expect(actToEvent(env('decline', { meta: { in_reply_to: 'x' } }))).toEqual({ kind: 'decline', who: 'ada' });
    expect(actToEvent(env('wait'))).toEqual({ kind: 'wait', who: 'ada' });
    expect(actToEvent(env('resolve', { thread: 't1' }))).toEqual({ kind: 'resolve', who: 'ada' });
  });

  it('returns null for acts it does not animate', () => {
    expect(actToEvent(env('nope' as Act))).toBeNull();
  });
});
