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

  it('maps steer to an interrupt-class redirect, directed or team-wide, escalating on urgent', () => {
    // Directed steer carries its target so the office runs a redirect over to them.
    expect(actToEvent(env('steer'))).toEqual({ kind: 'steer', from: 'ada', to: 'ben', urgent: false });
    expect(actToEvent(env('steer', { meta: { urgent: true } }))).toEqual({
      kind: 'steer',
      from: 'ada',
      to: 'ben',
      urgent: true,
    });
    // A team steer has no member target — the room-wide sweep carries it.
    expect(actToEvent(env('steer', { to: { kind: 'team' } }))).toEqual({
      kind: 'steer',
      from: 'ada',
      to: null,
      urgent: false,
    });
  });

  it('maps challenge to a question at the challenger (and the challenged, when directed)', () => {
    expect(actToEvent(env('challenge'))).toEqual({
      kind: 'challenge',
      from: 'ada',
      to: 'ben',
      urgent: false,
    });
    expect(actToEvent(env('challenge', { to: { kind: 'team' }, meta: { urgent: true } }))).toEqual({
      kind: 'challenge',
      from: 'ada',
      to: null,
      urgent: true,
    });
  });

  it('maps defer to a sender-anchored plan mutation (its target is a Goal, not a member)', () => {
    expect(actToEvent(env('defer', { meta: { goal_id: 'g1', wave: 3 } }))).toEqual({
      kind: 'defer',
      who: 'ada',
    });
  });

  it('returns null for acts it does not animate', () => {
    expect(actToEvent(env('nope' as Act))).toBeNull();
  });
});
