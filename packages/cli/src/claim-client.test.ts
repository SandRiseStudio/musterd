import { PROTOCOL_VERSION } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { buildClaimFrame, parseClaimResponse, parseClaimTarget } from './claim-client.js';

/** Minimal valid seat for `occupied` (MemberSchema: id/team/name/kind/created_at required). */
const seat = { id: 'm1', team: 'dawn', name: 'Ada', kind: 'agent' as const, created_at: 1 };

describe('parseClaimTarget (MUSTERD_CLAIM env string, ADR 075)', () => {
  it('parses seat:<name>', () => {
    expect(parseClaimTarget('seat:Ada')).toEqual({ seat: 'Ada' });
  });
  it('parses role:<name>', () => {
    expect(parseClaimTarget('role:backend')).toEqual({ role: 'backend' });
  });
  it('parses observe', () => {
    expect(parseClaimTarget('observe')).toEqual({ observe: true });
  });
  it('trims whitespace', () => {
    expect(parseClaimTarget('  seat:Ada  ')).toEqual({ seat: 'Ada' });
  });
  it('rejects an empty string', () => {
    expect(() => parseClaimTarget('')).toThrow(/MUSTERD_CLAIM is empty/);
    expect(() => parseClaimTarget(undefined)).toThrow(/MUSTERD_CLAIM is empty/);
  });
  it('rejects a malformed value with no separator', () => {
    expect(() => parseClaimTarget('Ada')).toThrow(/malformed/);
  });
  it('rejects a kind with no name after the colon', () => {
    expect(() => parseClaimTarget('seat:')).toThrow(/names no target/);
  });
  it('rejects an unknown kind', () => {
    expect(() => parseClaimTarget('pool:backend')).toThrow(/unknown kind "pool"/);
  });
});

describe('buildClaimFrame (SPEC A.3, ADR 078)', () => {
  it('builds a claim with a seat target + no grant', () => {
    const f = buildClaimFrame({
      team: 'dawn',
      key: 'mskey_x',
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(f.type).toBe('claim');
    expect(f.v).toBe(PROTOCOL_VERSION);
    expect(f.grant).toBeUndefined();
    expect(f.target).toEqual({ seat: 'Ada' });
  });
  it('builds a claim with a role target + a pre-issued grant', () => {
    const f = buildClaimFrame({
      team: 'dawn',
      key: 'mskey_x',
      target: { role: 'backend' },
      surface: 'claude-code',
      grant: 'msgr_y',
    });
    expect(f.grant).toBe('msgr_y');
    expect(f.target).toEqual({ role: 'backend' });
  });
  it('throws on a bad target shape', () => {
    expect(() =>
      buildClaimFrame({
        team: 'dawn',
        key: 'mskey_x',
        target: { observe: false } as never,
        surface: 'cli',
      }),
    ).toThrow();
  });
});

describe('parseClaimResponse (state machine, SPEC A.3)', () => {
  it('parses occupied → success outcome (no charter)', () => {
    const o = parseClaimResponse({
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    expect(o.state).toBe('occupied');
    if (o.state === 'occupied') {
      expect(o.presenceId).toBe('01J');
      expect(o.serverTime).toBe(7);
      expect(o.seat.name).toBe('Ada');
      expect(o.charter).toBeUndefined();
    }
  });
  it('parses occupied → carries charter when served', () => {
    const o = parseClaimResponse({
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      charter: 'you ship the CLI',
      memory: null,
    });
    expect(o.state).toBe('occupied');
    if (o.state === 'occupied') expect(o.charter).toBe('you ship the CLI');
  });
  it('rejects an occupied frame with a non-null memory (reserved seam)', () => {
    expect(() =>
      parseClaimResponse({
        type: 'occupied',
        seat,
        presence_id: '01J',
        server_time: 7,
        memory: { x: 1 },
      }),
    ).toThrow();
  });
  it('parses refused → denial outcome with claimable + hint', () => {
    const o = parseClaimResponse({
      type: 'refused',
      code: 'claim_conflict',
      message: 'seat taken',
      claimable: ['backend-2'],
      hint: 'musterd claim --role backend',
    });
    expect(o.state).toBe('refused');
    if (o.state === 'refused') {
      expect(o.code).toBe('claim_conflict');
      expect(o.claimable).toEqual(['backend-2']);
      expect(o.hint).toBe('musterd claim --role backend');
    }
  });
  it('parses each refusal code', () => {
    for (const code of ['forbidden', 'not_found', 'disabled', 'banned', 'expired_grant'] as const) {
      const o = parseClaimResponse({
        type: 'refused',
        code,
        message: 'no',
        claimable: [],
        hint: 'x',
      });
      expect(o.state).toBe('refused');
      if (o.state === 'refused') expect(o.code).toBe(code);
    }
  });
  it('parses pending → wait state (non-terminal)', () => {
    const o = parseClaimResponse({ type: 'pending', request_id: '01J', message: 'asked admins' });
    expect(o.state).toBe('pending');
    if (o.state === 'pending') {
      expect(o.requestId).toBe('01J');
      expect(o.message).toBe('asked admins');
    }
  });
  it('rejects an unknown frame type', () => {
    expect(() => parseClaimResponse({ type: 'welcome', member: 'Ada' })).toThrow(
      /not occupied\/refused\/pending/,
    );
  });
  it('rejects a non-object', () => {
    expect(() => parseClaimResponse('nope')).toThrow(/not an object/);
    expect(() => parseClaimResponse(null)).toThrow(/not an object/);
  });
});
