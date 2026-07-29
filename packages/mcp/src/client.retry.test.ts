import type { Envelope } from '@musterd/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MusterdClient, RETRY_DELAYS_MS } from './client.js';

/*
 * The daemon bounce is a ~849ms hole in HTTP availability that the auto-refresher has driven 116 times
 * through live sessions (lane 01KYQP9VMT). These tests pin the three restraints that make surviving it
 * safe: a refused WRITE is retried, a reset one never is, and a read is left to self-heal.
 */

/** Node's fetch shape: the useful code lives on `cause`, never in the message. */
function fetchError(code: string): TypeError {
  const err = new TypeError('fetch failed');
  (err as unknown as { cause: { code: string } }).cause = { code };
  return err;
}

const okResponse = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function client(): MusterdClient {
  return new MusterdClient({
    server: 'http://x',
    team: 'revive',
    agent_key: 'mskey_team',
    member: 'miley',
  } as never);
}

const envelope = { from: 'miley', to: '@team', act: 'status_update', body: 'x' } as Envelope;

/** A write — the thing whose loss is the actual damage. */
const send = () => client().sendEnvelope(envelope);

describe('MusterdClient retries a WRITE across a daemon bounce', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries a refused connection and succeeds — the bounce becomes invisible', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(fetchError('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fn);

    await expect(send()).resolves.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('survives an outage longer than one retry delay', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(fetchError('ECONNREFUSED'))
      .mockRejectedValueOnce(fetchError('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fn);

    await expect(send()).resolves.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('NEVER retries a reset connection — that act may already have been recorded', async () => {
    // The central restraint: re-posting a live-then-severed connection would double-send an act. Node
    // reports it with the same `TypeError: fetch failed` message as a refusal, so only `cause.code`
    // can tell them apart.
    const fn = vi.fn().mockRejectedValue(fetchError('ECONNRESET'));
    vi.stubGlobal('fetch', fn);

    await expect(send()).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the full budget rather than hanging on a daemon that is really gone', async () => {
    const fn = vi.fn().mockRejectedValue(fetchError('ECONNREFUSED'));
    vi.stubGlobal('fetch', fn);

    await expect(send()).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
  });

  it('does not retry a server error — a 409 is an answer, not a lost connection', async () => {
    const fn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'conflict', message: 'nope' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fn);

    await expect(send()).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('a READ is left to fail fast', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not retry a refused GET — the next poll fetches it again anyway', async () => {
    // Retrying reads would put the whole budget in front of every tool boundary's
    // interrupt-check (ADR 088) whenever the daemon is stopped: a permanently sluggish session
    // traded for a rare lost read, which is a worse bargain than the bug.
    const fn = vi.fn().mockRejectedValue(fetchError('ECONNREFUSED'));
    vi.stubGlobal('fetch', fn);

    await expect(client().roster()).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('the retry budget', () => {
  it('covers the measured 849ms bounce with margin, and still fails fast', () => {
    const total = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(849);
    expect(total).toBeLessThan(3000);
  });
});
