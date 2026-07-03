import { describe, expect, it, vi } from 'vitest';
import { watchClaim, type ClaimSocket } from './client.js';

/** Minimal fake socket: records sent frames + lets the test emit open/message/error. */
class FakeSocket implements ClaimSocket {
  handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  sent: string[] = [];
  closed = false;
  on(event: string, cb: (arg?: unknown) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(event: 'open' | 'message' | 'error', arg?: unknown): void {
    (this.handlers[event] ?? []).forEach((cb) => cb(arg));
  }
}

const seat = { id: 'm1', team: 'dawn', name: 'Ada', kind: 'agent' as const, created_at: 1 };
const base = {
  wsUrl: 'ws://x',
  team: 'dawn',
  key: 'mskey_x',
  target: { seat: 'Ada' } as const,
  surface: 'cli',
  onDeliver: vi.fn(),
};

function harness() {
  const sock = new FakeSocket();
  const opts = {
    ...base,
    createSocket: () => sock,
    onOccupied: vi.fn(),
    onPending: vi.fn(),
    onRefused: vi.fn(),
    onError: vi.fn(),
    onPresence: vi.fn(),
  };
  const handle = watchClaim(opts);
  return { sock, opts, handle };
}

describe('watchClaim (SPEC A.3, ADR 075/078) — handshake state machine', () => {
  it('sends a claim frame on open (not hello)', () => {
    const { sock } = harness();
    sock.emit('open');
    const frame = JSON.parse(sock.sent[0]);
    expect(frame.type).toBe('claim');
    expect(frame.team).toBe('dawn');
    expect(frame.key).toBe('mskey_x');
    expect(frame.target).toEqual({ seat: 'Ada' });
    expect(frame.surface).toBe('cli');
    expect(frame.grant).toBeUndefined();
  });

  it('includes the grant when supplied', () => {
    const sock = new FakeSocket();
    watchClaim({ ...base, grant: 'msgr_y', createSocket: () => sock });
    sock.emit('open');
    expect(JSON.parse(sock.sent[0]).grant).toBe('msgr_y');
  });

  it('occupied → onOccupied + subscribe + heartbeat', () => {
    const { sock, opts } = harness();
    sock.emit('open');
    sock.emit(
      'message',
      JSON.stringify({ type: 'occupied', seat, presence_id: '01J', server_time: 7, memory: null }),
    );
    expect(opts.onOccupied).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', name: 'Ada' }),
      '01J',
      undefined,
    );
    // next frame after the claim is the subscribe
    const frames = sock.sent.map((s) => JSON.parse(s));
    expect(frames.some((f) => f.type === 'subscribe' && f.scope === 'team')).toBe(true);
  });

  it('occupied carrying a resume grant (ADR 087) threads the token to onOccupied', () => {
    const { sock, opts } = harness();
    sock.emit('open');
    sock.emit(
      'message',
      JSON.stringify({
        type: 'occupied',
        seat,
        presence_id: '01J',
        server_time: 7,
        grant: 'msgr_resume123',
        memory: null,
      }),
    );
    expect(opts.onOccupied).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', name: 'Ada' }),
      '01J',
      'msgr_resume123',
    );
  });

  it('refused → onRefused (terminal, no subscribe)', () => {
    const { sock, opts } = harness();
    sock.emit('open');
    sock.emit(
      'message',
      JSON.stringify({
        type: 'refused',
        code: 'claim_conflict',
        message: 'taken',
        claimable: ['backend-2'],
        hint: 'musterd claim --role backend',
      }),
    );
    expect(opts.onRefused).toHaveBeenCalledWith(
      'claim_conflict',
      'taken',
      ['backend-2'],
      'musterd claim --role backend',
    );
    expect(sock.sent.map((s) => JSON.parse(s))).not.toContainEqual(
      expect.objectContaining({ type: 'subscribe' }),
    );
  });

  it('pending → onPending; then a pushed occupied resolves it (subscribe fires)', () => {
    const { sock, opts } = harness();
    sock.emit('open');
    sock.emit(
      'message',
      JSON.stringify({ type: 'pending', request_id: '01J', message: 'asked admins' }),
    );
    expect(opts.onPending).toHaveBeenCalledWith('01J', 'asked admins');
    expect(sock.sent.map((s) => JSON.parse(s))).not.toContainEqual(
      expect.objectContaining({ type: 'subscribe' }),
    );
    // admin decides → server pushes occupied on the same socket (spec-gap 3)
    sock.emit(
      'message',
      JSON.stringify({ type: 'occupied', seat, presence_id: '01J', server_time: 8, memory: null }),
    );
    expect(opts.onOccupied).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', name: 'Ada' }),
      '01J',
      undefined,
    );
    expect(sock.sent.map((s) => JSON.parse(s))).toContainEqual(
      expect.objectContaining({ type: 'subscribe' }),
    );
  });

  it('delivers + presence after occupied (the live session)', () => {
    const { sock, opts } = harness();
    sock.emit('open');
    sock.emit(
      'message',
      JSON.stringify({ type: 'occupied', seat, presence_id: '01J', server_time: 7, memory: null }),
    );
    sock.emit(
      'message',
      JSON.stringify({ type: 'presence', member: 'Ada', status: 'online', surface: 'cli' }),
    );
    expect(opts.onPresence).toHaveBeenCalledWith('Ada', 'online', 'cli');
  });

  it('close stops the heartbeat + closes the socket', () => {
    const { sock, handle } = harness();
    sock.emit('open');
    sock.emit(
      'message',
      JSON.stringify({ type: 'occupied', seat, presence_id: '01J', server_time: 7, memory: null }),
    );
    handle.close();
    expect(sock.closed).toBe(true);
  });

  it('surface error → onError', () => {
    const { sock, opts } = harness();
    sock.emit('error', new Error('boom'));
    expect(opts.onError).toHaveBeenCalledWith('boom');
  });
});
