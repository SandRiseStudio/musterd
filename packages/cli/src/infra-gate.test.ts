import { afterEach, describe, expect, it, vi } from 'vitest';
import { infraTouchWarning } from './infra-gate.js';

/**
 * ADR 227 inc 2 — the CLI half of the warn-only infra-touch gate. Everything here is about the
 * SILENCE contract: the check may only ever add a line of text, so every failure mode — no
 * workspace identity, daemon down, non-200, malformed body — must collapse to null, never to an
 * error and never to a block. The daemon owns the decision + the audit row (integration.test.ts).
 */

const identity = {
  server: 'http://127.0.0.1:9',
  team: 'dawn',
  name: 'dolly',
  key: 'mskey_x',
  surface: 'claude-code',
};

afterEach(() => vi.restoreAllMocks());

describe('infraTouchWarning', () => {
  it('returns the daemon-composed warning text for a non-holder seat', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            warn: {
              text: 'izzo holds platform — route an ask instead (ADR 227)',
              holders: ['izzo'],
            },
          }),
          { status: 200 },
        ),
    );
    const warn = await infraTouchWarning('restart', { identity: () => identity, fetchImpl });
    expect(warn).toContain('izzo holds platform');
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toBe('http://127.0.0.1:9/teams/dawn/infra-gate?verb=restart');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer mskey_x');
    expect((init.headers as Record<string, string>)['x-musterd-seat']).toBe('dolly');
  });

  it('is silent when the daemon says null (holder / human / unknown seat)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ warn: null }), { status: 200 }),
    );
    expect(await infraTouchWarning('refresh', { identity: () => identity, fetchImpl })).toBeNull();
  });

  it('is silent with no workspace-explicit identity (an unbound folder is not the audience)', async () => {
    const fetchImpl = vi.fn();
    expect(await infraTouchWarning('restart', { identity: () => null, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is silent when the daemon is unreachable — never a prerequisite for the command that fixes health', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await infraTouchWarning('install', { identity: () => identity, fetchImpl })).toBeNull();
  });

  it('is silent on a non-200 or malformed body (an old daemon has no such route)', async () => {
    const notFound = vi.fn(async () => new Response('nope', { status: 404 }));
    expect(
      await infraTouchWarning('restart', { identity: () => identity, fetchImpl: notFound }),
    ).toBeNull();
    const garbage = vi.fn(async () => new Response('{', { status: 200 }));
    expect(
      await infraTouchWarning('restart', { identity: () => identity, fetchImpl: garbage }),
    ).toBeNull();
  });
});
