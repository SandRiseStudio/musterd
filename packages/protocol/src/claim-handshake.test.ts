import { describe, expect, it } from 'vitest';
import { P3_AUDIT_ACTIONS } from './audit.js';
import {
  ClaimFrame,
  ClaimTargetSchema,
  OccupiedFrame,
  PendingFrame,
  RefusedCodeSchema,
  RefusedFrame,
} from './claim-handshake.js';
import { ErrorCodeSchema } from './errors.js';
import { PROTOCOL_VERSION } from './version.js';

/** Minimal valid seat for `occupied` (MemberSchema: id/team/name/kind/created_at required; rest defaulted). */
const seat = { id: 'm1', team: 'dawn', name: 'Ada', kind: 'agent' as const, created_at: 1 };

describe('claim handshake frames (ADR 078 / SPEC A.3)', () => {
  it('parses a claim with a named-seat target', () => {
    const f = ClaimFrame.parse({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: 'mskey_x',
      target: { seat: 'Ada' },
      surface: 'claude-code',
    });
    expect(f.type).toBe('claim');
    expect(f.grant).toBeUndefined();
    expect(f.target).toEqual({ seat: 'Ada' });
  });

  it('parses a claim with a role-pool target + a pre-issued grant', () => {
    const f = ClaimFrame.parse({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: 'mskey_x',
      target: { role: 'backend' },
      grant: 'msgr_y',
      surface: 'cli',
    });
    expect(f.grant).toBe('msgr_y');
    expect(f.target).toEqual({ role: 'backend' });
  });

  it('parses a claim with an observe target (human credential)', () => {
    const f = ClaimFrame.parse({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: 'mscr_nick',
      target: { observe: true },
      surface: 'cursor',
    });
    expect(f.target).toEqual({ observe: true });
  });

  it('rejects an observe target that is not literally true', () => {
    const r = ClaimFrame.safeParse({
      type: 'claim',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      key: 'mscr_nick',
      target: { observe: false },
      surface: 'cursor',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a claim missing both seat and role and observe', () => {
    const r = ClaimTargetSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('rejects a claim with the wrong protocol version pin', () => {
    const r = ClaimFrame.safeParse({
      type: 'claim',
      v: 'musterd/0.9',
      team: 'dawn',
      key: 'mskey_x',
      target: { seat: 'Ada' },
      surface: 'cli',
    });
    expect(r.success).toBe(false);
  });

  it('parses an occupied frame with charter + the reserved null memory seam', () => {
    const f = OccupiedFrame.parse({
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      charter: 'you ship the CLI',
      memory: null,
    });
    expect(f.type).toBe('occupied');
    expect(f.memory).toBeNull();
    expect(f.charter).toBe('you ship the CLI');
  });

  it('parses an occupied frame carrying a memory envelope (ADR 093)', () => {
    const f = OccupiedFrame.parse({
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: {
        headline: 'mid-refactor of ws.ts eviction, tests red',
        saved_at: 1751830000000,
        size_bytes: 512,
      },
    });
    expect(f.memory?.headline).toContain('mid-refactor');
  });

  it('still accepts memory: null (no saved memory) and rejects a body on the envelope', () => {
    const f = OccupiedFrame.parse({
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    expect(f.memory).toBeNull();
    const bad = OccupiedFrame.safeParse({
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: { headline: 'x', saved_at: 1, size_bytes: 1, body: 'nope' },
    });
    expect(bad.success).toBe(false); // envelope is strict: the body never rides occupy
  });

  it('rejects a headline over 120 chars', () => {
    const bad = OccupiedFrame.safeParse({
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: { headline: 'x'.repeat(121), saved_at: 1, size_bytes: 1 },
    });
    expect(bad.success).toBe(false);
  });

  it('parses a refused frame for each refusal code incl. account states', () => {
    for (const code of [
      'claim_conflict',
      'forbidden',
      'not_found',
      'disabled',
      'banned',
      'expired_grant',
    ] as const) {
      const f = RefusedFrame.parse({
        type: 'refused',
        code,
        message: 'no',
        claimable: ['Ada'],
        hint: 'musterd claim --role backend',
      });
      expect(f.code).toBe(code);
      expect(f.claimable).toEqual(['Ada']);
    }
  });

  it('rejects an unknown refused code', () => {
    expect(RefusedCodeSchema.safeParse('archived').success).toBe(false);
    expect(RefusedCodeSchema.safeParse('ok').success).toBe(false);
  });

  it('parses a pending frame (no-grant → admin request lane)', () => {
    const f = PendingFrame.parse({ type: 'pending', request_id: '01J', message: 'asked admins' });
    expect(f.type).toBe('pending');
    expect(f.request_id).toBe('01J');
  });

  it('added the P3 HTTP error codes claim_conflict + expired_grant to ErrorCode', () => {
    expect(ErrorCodeSchema.safeParse('claim_conflict').success).toBe(true);
    expect(ErrorCodeSchema.safeParse('expired_grant').success).toBe(true);
  });

  it('pins the P3 audit-verb vocabulary without closing the open action string', () => {
    // The reference tuple names the verbs the P3 server emits (ADR 078); AuditEntry.action stays open
    // (ADR 074), so a verb not in this list still validates. This tuple is for naming consistency only.
    expect(P3_AUDIT_ACTIONS).toContain('grant.issue');
    expect(P3_AUDIT_ACTIONS).toContain('claim.occupy');
    expect(P3_AUDIT_ACTIONS).toContain('request.decide');
    // A future verb survives the open action field:
    expect(typeof P3_AUDIT_ACTIONS[0]).toBe('string');
  });
});
