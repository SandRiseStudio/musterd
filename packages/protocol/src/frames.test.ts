import { describe, expect, it } from 'vitest';
import { WSClientFrame, WSServerFrame } from './frames.js';
import { PROTOCOL_VERSION } from './version.js';

describe('WS frames', () => {
  it('parses a hello frame', () => {
    const f = WSClientFrame.parse({
      type: 'hello',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      as: 'Ada',
      token: 'mskd_x',
      surface: 'claude-code',
    });
    expect(f.type).toBe('hello');
  });

  it('parses provenance + workspace on hello (ADR 014)', () => {
    const f = WSClientFrame.parse({
      type: 'hello',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      as: 'Ada',
      token: 'mskd_x',
      surface: 'claude-code',
      provenance: 'session',
      workspace: 'movetrail@feat/login',
    });
    expect(f.type === 'hello' && f.provenance).toBe('session');
    expect(f.type === 'hello' && f.workspace).toBe('movetrail@feat/login');
  });

  it('rejects an unknown provenance value in hello', () => {
    const r = WSClientFrame.safeParse({
      type: 'hello',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      as: 'Ada',
      token: 'x',
      surface: 'cli',
      provenance: 'vibes',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown surface in hello', () => {
    const r = WSClientFrame.safeParse({
      type: 'hello',
      v: PROTOCOL_VERSION,
      team: 'dawn',
      as: 'Ada',
      token: 'x',
      surface: 'pager',
    });
    expect(r.success).toBe(false);
  });

  it('parses an ack and a deliver server frame', () => {
    expect(WSServerFrame.parse({ type: 'ack', id: 'm1' }).type).toBe('ack');
    const d = WSServerFrame.parse({
      type: 'deliver',
      envelope: {
        id: 'm1',
        v: PROTOCOL_VERSION,
        team: 'dawn',
        from: 'Ada',
        to: { kind: 'team' },
        act: 'status_update',
        body: 'hi',
        ts: 1,
      },
    });
    expect(d.type).toBe('deliver');
  });

  it('parses an error frame with a known code', () => {
    const e = WSServerFrame.parse({ type: 'error', code: 'forbidden', message: 'nope' });
    expect(e.type).toBe('error');
  });
});
