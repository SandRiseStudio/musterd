import { describe, expect, it } from 'vitest';
import {
  ELIGIBLE_ACTS,
  EnvelopeSchema,
  eligibleOf,
  makeEnvelope,
  MAX_ELIGIBLE,
} from './envelope.js';
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

  it('round-trips the steering acts steer/challenge (ADR 103)', () => {
    expect(makeEnvelope({ ...base, act: 'steer', body: 'use v2' }).act).toBe('steer');
    expect(makeEnvelope({ ...base, act: 'challenge', body: 'why this task?' }).act).toBe(
      'challenge',
    );
  });

  it('requires a non-empty meta.goal_id on defer (the Goal it reorders/defers, ADR 103)', () => {
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

  describe('the to-human ask stream (ADR 147)', () => {
    it('requires a valid meta.species and meta.tier on ask', () => {
      expect(() => makeEnvelope({ ...base, act: 'ask', body: 'ship it?' })).toThrow();
      expect(() => makeEnvelope({ ...base, act: 'ask', meta: { species: 'consult' } })).toThrow(); // missing tier
      expect(() =>
        makeEnvelope({ ...base, act: 'ask', meta: { species: 'bogus', tier: 'blocking' } }),
      ).toThrow(); // bad species
      expect(() =>
        makeEnvelope({ ...base, act: 'ask', meta: { species: 'escalate', tier: 'huge' } }),
      ).toThrow(); // bad tier
      const ok = makeEnvelope({
        ...base,
        act: 'ask',
        body: 'drop the prod table?',
        meta: { species: 'approve', tier: 'blocking' },
      });
      expect(ok.act).toBe('ask');
      expect(ok.meta).toMatchObject({ species: 'approve', tier: 'blocking' });
    });

    it('requires ask_ref + a non-empty risk/chosen_approach on a risk_accepted resolution', () => {
      // ask_outcome present ⟹ ask_ref required
      expect(() =>
        makeEnvelope({ ...base, act: 'status_update', meta: { ask_outcome: 'risk_accepted' } }),
      ).toThrow();
      // risk_accepted ⟹ risk + chosen_approach required (the auditable record can't be empty)
      expect(() =>
        makeEnvelope({
          ...base,
          act: 'status_update',
          meta: { ask_outcome: 'risk_accepted', ask_ref: 'msg-0' },
        }),
      ).toThrow();
      expect(() =>
        makeEnvelope({
          ...base,
          act: 'status_update',
          meta: { ask_outcome: 'risk_accepted', ask_ref: 'msg-0', risk: 'may double-charge' },
        }),
      ).toThrow(); // missing chosen_approach
      const ok = makeEnvelope({
        ...base,
        act: 'status_update',
        meta: {
          ask_outcome: 'risk_accepted',
          ask_ref: 'msg-0',
          risk: 'may double-charge',
          chosen_approach: 'proceeded idempotently with a dedupe key',
        },
      });
      expect(ok.meta).toMatchObject({ ask_outcome: 'risk_accepted', ask_ref: 'msg-0' });
    });

    it('allows a held resolution with just ask_ref, and rejects a bad outcome', () => {
      const held = makeEnvelope({
        ...base,
        act: 'status_update',
        meta: { ask_outcome: 'held', ask_ref: 'msg-0' },
      });
      expect(held.meta).toMatchObject({ ask_outcome: 'held', ask_ref: 'msg-0' });
      expect(() =>
        makeEnvelope({
          ...base,
          act: 'status_update',
          meta: { ask_outcome: 'proceeded', ask_ref: 'msg-0' },
        }),
      ).toThrow();
    });

    it('requires meta.until on a "deciding" wait that names an ask, but not on a bare wait', () => {
      expect(makeEnvelope({ ...base, act: 'wait' }).act).toBe('wait'); // bare wait unaffected
      expect(() => makeEnvelope({ ...base, act: 'wait', meta: { ask_ref: 'msg-0' } })).toThrow(); // ask_ref ⟹ until required
      const ok = makeEnvelope({
        ...base,
        act: 'wait',
        meta: { ask_ref: 'msg-0', until: '1h' },
      });
      expect(ok.meta).toMatchObject({ ask_ref: 'msg-0', until: '1h' });
    });

    describe('the deferring wait (ADR 211 §1)', () => {
      it('accepts a lane condition and a reply condition', () => {
        const lane = makeEnvelope({
          ...base,
          act: 'wait',
          meta: { defer_ref: 'msg-0', until: { lane: 'lane-1' } },
        });
        expect(lane.meta).toMatchObject({ defer_ref: 'msg-0', until: { lane: 'lane-1' } });
        const reply = makeEnvelope({
          ...base,
          act: 'wait',
          meta: { defer_ref: 'msg-0', until: { reply: true } },
        });
        expect(reply.meta).toMatchObject({ defer_ref: 'msg-0', until: { reply: true } });
      });

      it('requires meta.until when a wait names the act it defers', () => {
        expect(() =>
          makeEnvelope({ ...base, act: 'wait', meta: { defer_ref: 'msg-0' } }),
        ).toThrow();
        expect(() =>
          makeEnvelope({ ...base, act: 'wait', meta: { defer_ref: '  ', until: { reply: true } } }),
        ).toThrow();
      });

      it('rejects a condition that is neither a lane nor a reply', () => {
        expect(() =>
          makeEnvelope({ ...base, act: 'wait', meta: { defer_ref: 'msg-0', until: { at: 1 } } }),
        ).toThrow();
        expect(() =>
          makeEnvelope({
            ...base,
            act: 'wait',
            meta: { defer_ref: 'msg-0', until: { reply: false } },
          }),
        ).toThrow();
        expect(() =>
          makeEnvelope({
            ...base,
            act: 'wait',
            meta: { defer_ref: 'msg-0', until: { lane: 'l1', reply: true } },
          }),
        ).toThrow();
      });

      // ADR 179: the daemon runs no clocks. A duration is the DECIDING wait's shape, never this one.
      it('rejects a wall-clock until on a deferring wait', () => {
        expect(() =>
          makeEnvelope({ ...base, act: 'wait', meta: { defer_ref: 'msg-0', until: '1h' } }),
        ).toThrow();
        expect(() =>
          makeEnvelope({
            ...base,
            act: 'wait',
            meta: { defer_ref: 'msg-0', until: { at: 1785790000000 } },
          }),
        ).toThrow();
      });

      it('rejects a wait that is both deciding and deferring — until would be ambiguous', () => {
        expect(() =>
          makeEnvelope({
            ...base,
            act: 'wait',
            meta: { ask_ref: 'msg-0', defer_ref: 'msg-0', until: { reply: true } },
          }),
        ).toThrow();
      });
    });
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

describe('meta.eligible (the eligible set)', () => {
  /** A team-addressed act, which is what an eligible set always rides on. */
  const teamBase = { ...base, to: { kind: 'team' } as const };
  const withEligible = (eligible: unknown, act = 'message') =>
    makeEnvelope({ ...teamBase, act, body: 'either of you know?', meta: { eligible } });

  it('accepts two names', () => {
    expect(withEligible(['Lin', 'Ada2']).meta).toMatchObject({ eligible: ['Lin', 'Ada2'] });
  });

  it('accepts the cap exactly', () => {
    expect(withEligible(['a', 'b', 'c', 'd']).meta).toMatchObject({
      eligible: ['a', 'b', 'c', 'd'],
    });
  });

  it('rejects more than MAX_ELIGIBLE, pointing at @team', () => {
    expect(() => withEligible(['a', 'b', 'c', 'd', 'e'])).toThrow(/@team/);
  });

  it('rejects a single name — one seat is a directed act', () => {
    expect(() => withEligible(['Lin'])).toThrow(/at least 2/);
  });

  it('rejects a repeated seat', () => {
    expect(() => withEligible(['Lin', 'Lin'])).toThrow(/same seat twice/);
  });

  it('rejects an empty name', () => {
    expect(() => withEligible(['Lin', '  '])).toThrow(/empty name/);
  });

  it('rejects a non-array', () => {
    expect(() => withEligible('Lin,Ada2')).toThrow(/array of seat names/);
  });

  it('rejects a mixed-type array', () => {
    expect(() => withEligible(['Lin', 3])).toThrow(/array of seat names/);
  });

  it.each(['message', 'request_help', 'challenge'])('allows an eligible set on %s', (act) => {
    expect(withEligible(['Lin', 'Ada2'], act).meta).toMatchObject({ eligible: ['Lin', 'Ada2'] });
  });

  // A handoff to two seats is incoherent — two owners is zero owners — and the single-target acts
  // have nowhere to put a second addressee. This restriction is what earns one global discharge rule.
  it.each(['handoff', 'accept', 'decline', 'defer', 'steer', 'status_update', 'ask', 'resolve'])(
    'rejects an eligible set on %s',
    (act) => {
      expect(() => withEligible(['Lin', 'Ada2'], act)).toThrow(/cannot carry meta\.eligible/);
    },
  );

  it('leaves an envelope without the key alone', () => {
    expect(makeEnvelope({ ...teamBase, act: 'message', body: 'hi' }).meta).toBeNull();
  });

  it('eligibleOf reads the shape, and returns null rather than a filtered list', () => {
    expect(eligibleOf(null)).toBeNull();
    expect(eligibleOf(undefined)).toBeNull();
    expect(eligibleOf({})).toBeNull();
    expect(eligibleOf({ eligible: 'Lin' })).toBeNull();
    // Dropping the non-string silently would mean silently dropping an obligation.
    expect(eligibleOf({ eligible: ['Lin', 3] })).toBeNull();
    expect(eligibleOf({ eligible: ['Lin', 'Ada2'] })).toEqual(['Lin', 'Ada2']);
  });

  it('MAX_ELIGIBLE is four', () => {
    expect(MAX_ELIGIBLE).toBe(4);
  });

  it('ELIGIBLE_ACTS is exactly the three question-shaped acts', () => {
    expect([...ELIGIBLE_ACTS].sort()).toEqual(['challenge', 'message', 'request_help']);
  });
});
