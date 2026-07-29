import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client.js';
import { RETRY_DELAYS_MS, connectionNeverEstablished, worthRetrying } from './errors.js';

/*
 * The CLI carries acts for hooks and humans over the same HTTP path the MCP adapter uses, so it needs
 * the same tolerance for the ~849ms daemon-bounce outage (lane 01KYR0D28Z). It also has the tighter
 * constraint: the harness invokes it in a fresh short-lived process at every tool boundary, so a read
 * must never pay the retry budget.
 */

/** Node's fetch shape: the useful code lives on `cause`, never in the message. */
function fetchError(code: string): TypeError {
  const err = new TypeError('fetch failed');
  (err as unknown as { cause: { code: string } }).cause = { code };
  return err;
}

const okResponse = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const client = () => new HttpClient({ server: 'http://x', key: 'mskey_team', seat: 'miley' });

/** A write (POST /inbox/cursor) — the class whose loss actually damages state. */
const write = () => client().markRead('revive', '01KYR0D28ZJEXTB7TM0N95191S');

describe('HttpClient retries a WRITE across a daemon bounce', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries a refused connection instead of reporting the daemon down', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(fetchError('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fn);

    await expect(write()).resolves.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('NEVER retries a reset connection — it may already have been processed', async () => {
    const fn = vi.fn().mockRejectedValue(fetchError('ECONNRESET'));
    vi.stubGlobal('fetch', fn);

    await expect(write()).rejects.toThrow(/can't reach team server/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still reports the friendly unreachable error once the budget is spent', async () => {
    const fn = vi.fn().mockRejectedValue(fetchError('ECONNREFUSED'));
    vi.stubGlobal('fetch', fn);

    // The retry must not swallow the diagnosis a human depends on when the daemon really is stopped.
    await expect(write()).rejects.toThrow(/is the daemon running/);
    expect(fn).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
  });
});

describe('a READ fails fast, so the tool-boundary hook stays instant', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not retry a refused GET', async () => {
    const fn = vi.fn().mockRejectedValue(fetchError('ECONNREFUSED'));
    vi.stubGlobal('fetch', fn);

    await expect(client().roster('revive')).rejects.toThrow(/can't reach team server/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('classifies the hot interrupt-check path as not-worth-retrying', () => {
    // `GET /inbox/interrupt-check` runs at every tool boundary (ADR 088) in its own process, so an
    // in-process circuit breaker cannot spare it — only excluding reads can.
    expect(worthRetrying('GET')).toBe(false);
    expect(worthRetrying('POST')).toBe(true);
  });
});

describe('connectionNeverEstablished is narrower than isConnRefused', () => {
  it('accepts a refusal and rejects a reset, which the message text cannot distinguish', () => {
    expect(connectionNeverEstablished(fetchError('ECONNREFUSED'))).toBe(true);
    expect(connectionNeverEstablished(fetchError('ECONNRESET'))).toBe(false);
    // Both carry the identical message, which is exactly why a text match is the wrong predicate.
    expect(fetchError('ECONNREFUSED').message).toBe(fetchError('ECONNRESET').message);
  });

  it('rejects a timeout abort — a slow server is not a missing one', () => {
    expect(connectionNeverEstablished(new DOMException('timed out', 'TimeoutError'))).toBe(false);
    expect(connectionNeverEstablished(undefined)).toBe(false);
  });
});
