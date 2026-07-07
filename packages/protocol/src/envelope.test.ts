import { describe, expect, it } from 'vitest';
import { EnvelopeSchema, makeEnvelope } from './envelope.js';
import { PROTOCOL_VERSION } from './version.js';

const base = {
  id: 'msg-1',
  team: 'dawn',
  from: 'Ada',
  to: { kind: 'member', name: 'Lin' } as const,
  ts: 1733760000000,
};

describe('EnvelopeSchema', () => {
  it('round-trips a valid envelope and defaults body', () => {
    const env = makeEnvelope({ ...base, act: 'handoff', body: 'auth ready' });
    expect(env.v).toBe(PROTOCOL_VERSION);
    expect(env.act).toBe('handoff');
    expect(env.body).toBe('auth ready');
    expect(EnvelopeSchema.parse(env)).toEqual(env);
  });

  it('defaults missing body to empty string', () => {
    const env = makeEnvelope({ ...base, act: 'wait' });
    expect(env.body).toBe('');
  });

  it('rejects an unknown act', () => {
    const bad = { ...base, v: PROTOCOL_VERSION, act: 'shout', body: '', to: base.to };
    expect(EnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('preserves unknown meta keys (forward-compat)', () => {
    const env = makeEnvelope({
      ...base,
      act: 'status_update',
      meta: { progress: 0.5, futureField: 'keep me' },
    });
    expect(env.meta).toMatchObject({ progress: 0.5, futureField: 'keep me' });
  });

  it('requires meta.in_reply_to on accept', () => {
    expect(() => makeEnvelope({ ...base, act: 'accept' })).toThrow();
    const ok = makeEnvelope({ ...base, act: 'accept', meta: { in_reply_to: 'msg-0' } });
    expect(ok.meta).toMatchObject({ in_reply_to: 'msg-0' });
  });

  it('requires meta.in_reply_to on decline', () => {
    expect(() => makeEnvelope({ ...base, act: 'decline' })).toThrow();
    const ok = makeEnvelope({
      ...base,
      act: 'decline',
      meta: { in_reply_to: 'msg-0', reason: 'busy' },
    });
    expect(ok.meta).toMatchObject({ in_reply_to: 'msg-0', reason: 'busy' });
  });

  it('requires thread on resolve (the thread it closes)', () => {
    expect(() => makeEnvelope({ ...base, act: 'resolve' })).toThrow();
    const ok = makeEnvelope({ ...base, act: 'resolve', thread: 'msg-0', body: 'merged' });
    expect(ok.act).toBe('resolve');
    expect(ok.thread).toBe('msg-0');
  });

  it('requires a non-empty meta.urgent_reason when meta.urgent is true (ADR 044)', () => {
    expect(() => makeEnvelope({ ...base, act: 'request_help', meta: { urgent: true } })).toThrow();
    expect(() =>
      makeEnvelope({ ...base, act: 'request_help', meta: { urgent: true, urgent_reason: '  ' } }),
    ).toThrow();
    const ok = makeEnvelope({
      ...base,
      act: 'request_help',
      meta: { urgent: true, urgent_reason: 'prod is down' },
    });
    expect(ok.meta).toMatchObject({ urgent: true, urgent_reason: 'prod is down' });
  });

  it('leaves non-urgent envelopes untouched (urgent_reason only required when urgent)', () => {
    const env = makeEnvelope({ ...base, act: 'message', meta: { urgent: false } });
    expect(env.meta).toMatchObject({ urgent: false });
    expect(makeEnvelope({ ...base, act: 'message' }).meta).toBeNull();
  });

  it('round-trips the steering acts steer/challenge (ADR 102)', () => {
    expect(makeEnvelope({ ...base, act: 'steer', body: 'use v2' }).act).toBe('steer');
    expect(makeEnvelope({ ...base, act: 'challenge', body: 'why this task?' }).act).toBe(
      'challenge',
    );
  });

  it('requires a non-empty meta.goal_id on defer (the Goal it reorders/defers, ADR 102)', () => {
    expect(() => makeEnvelope({ ...base, act: 'defer' })).toThrow();
    expect(() => makeEnvelope({ ...base, act: 'defer', meta: { goal_id: '   ' } })).toThrow();
    const ok = makeEnvelope({
      ...base,
      act: 'defer',
      meta: { goal_id: 'insight-engine', wave: 'later' },
    });
    expect(ok.act).toBe('defer');
    expect(ok.meta).toMatchObject({ goal_id: 'insight-engine', wave: 'later' });
  });

  it('rejects a wrong protocol version', () => {
    const bad = { ...makeEnvelope({ ...base, act: 'message' }), v: 'musterd/9.9' };
    expect(EnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an invalid team slug', () => {
    expect(() => makeEnvelope({ ...base, team: 'Not A Slug', act: 'message' })).toThrow();
  });

  it('accepts team and broadcast recipients', () => {
    expect(makeEnvelope({ ...base, to: { kind: 'team' }, act: 'status_update' }).to).toEqual({
      kind: 'team',
    });
    expect(makeEnvelope({ ...base, to: { kind: 'broadcast' }, act: 'message' }).to).toEqual({
      kind: 'broadcast',
    });
  });
});
