import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDurationMs } from './args.js';
import { HttpClient } from './client.js';

/** Capture the headers of the first fetch call. */
function stubOkFetch() {
  // A fresh Response per call — one Response body is single-read.
  const fn = vi.fn().mockImplementation(async () => {
    return new Response(JSON.stringify({ members: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('HttpClient x-musterd-provenance forwarding (ADR 131 §6, inc 5)', () => {
  beforeEach(() => {
    delete process.env['MUSTERD_PROVENANCE'];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['MUSTERD_PROVENANCE'];
  });

  it('forwards x-musterd-provenance for an agent key when the env declares one — the wake path', async () => {
    process.env['MUSTERD_PROVENANCE'] = 'wake';
    const fn = stubOkFetch();
    await new HttpClient({
      server: 'http://x',
      key: 'mskey_team',
      seat: 'Ada',
      surface: 'cli',
    }).roster('dawn');
    const headers = (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-provenance']).toBe('wake');
  });

  it('sends nothing when unset, for junk values, or for a human credential (mirrors the model gate)', async () => {
    const fn = stubOkFetch();
    await new HttpClient({ server: 'http://x', key: 'mskey_team', seat: 'Ada' }).roster('dawn');
    let headers = (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-provenance']).toBeUndefined();

    process.env['MUSTERD_PROVENANCE'] = 'root'; // not a known provenance
    await new HttpClient({ server: 'http://x', key: 'mskey_team', seat: 'Ada' }).roster('dawn');
    headers = (fn.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-provenance']).toBeUndefined();

    process.env['MUSTERD_PROVENANCE'] = 'wake'; // a human shell must not label itself wake
    await new HttpClient({ server: 'http://x', key: 'mscr_human', seat: 'nick' }).roster('dawn');
    headers = (fn.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-provenance']).toBeUndefined();
  });
});

describe('parseDurationMs (the knob-flag duration shape)', () => {
  it('parses suffixed durations and refuses bare numbers with the shape named', () => {
    expect(parseDurationMs('45s', '--timeout')).toBe(45_000);
    expect(parseDurationMs('15m', '--cooldown')).toBe(900_000);
    expect(parseDurationMs('2h', '--cooldown')).toBe(7_200_000);
    expect(parseDurationMs('1.5m', '--cooldown')).toBe(90_000);
    expect(() => parseDurationMs('30', '--cooldown')).toThrow(/like 45s, 15m, or 2h/);
    expect(() => parseDurationMs('soon', '--cooldown')).toThrow(/like 45s, 15m, or 2h/);
  });
});
