import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client.js';

/** Capture the headers of the first fetch call. */
function stubOkFetch() {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ members: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('HttpClient x-musterd-model forwarding (ADR 119 / 121)', () => {
  beforeEach(() => {
    delete process.env['MUSTERD_MODEL'];
    delete process.env['ANTHROPIC_MODEL'];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['MUSTERD_MODEL'];
    delete process.env['ANTHROPIC_MODEL'];
  });

  it('forwards x-musterd-model for an agent key when the env declares a model', async () => {
    process.env['MUSTERD_MODEL'] = 'qwen2.5:3b-instruct';
    const fn = stubOkFetch();
    await new HttpClient({
      server: 'http://x',
      key: 'mskey_team',
      seat: 'Ada',
      surface: 'cli',
    }).roster('dawn');
    const headers = (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-model']).toBe('qwen2.5:3b-instruct');
  });

  it('does not forward x-musterd-model for a human credential even when the env declares a model (ADR 121)', async () => {
    process.env['MUSTERD_MODEL'] = 'claude-opus-4-8';
    const fn = stubOkFetch();
    await new HttpClient({
      server: 'http://x',
      key: 'mscr_human',
      seat: 'nick',
      surface: 'cli',
    }).roster('dawn');
    const headers = (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-model']).toBeUndefined();
  });
});
