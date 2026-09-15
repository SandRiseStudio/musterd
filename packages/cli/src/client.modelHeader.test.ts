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

  it('forwards x-musterd-model for an agent-seat credential when the env declares a model', async () => {
    process.env['MUSTERD_MODEL'] = 'qwen2.5:3b-instruct';
    const fn = stubOkFetch();
    await new HttpClient({
      server: 'http://x',
      key: 'msac_agent',
      seat: 'Ada',
      sessionLease: 'msls_presence',
      surface: 'cli',
    }).roster('dawn');
    const headers = (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-model']).toBe('qwen2.5:3b-instruct');
  });

  /**
   * ADR 246. The env is the WEAKEST tier of the ADR 158 ladder and it was the only one the CLI
   * could see, so a hook one-shot in a workspace whose harness had been OBSERVED seconds earlier
   * attested nothing at all. Measured 2026-08-05: seat miley's binding carried
   * `model_observed: claude-fable-5` stamped twelve seconds before an ambient touch wrote a presence
   * row with `model = null` — and that null row, being the newest non-held one, took her out of the
   * ADR 188 review pool with no ledger row anywhere saying so.
   *
   * The caller resolves the full ladder (it is the layer that already holds the binding) and passes
   * the answer down; the client stays a transport and never reads the filesystem.
   */
  it('prefers the caller-resolved attestation over the env declaration (ADR 246)', async () => {
    process.env['MUSTERD_MODEL'] = 'stale-env-value';
    const fn = stubOkFetch();
    await new HttpClient({
      server: 'http://x',
      key: 'msac_agent',
      seat: 'Ada',
      sessionLease: 'msls_presence',
      surface: 'cli',
      model: 'claude-fable-5',
    }).roster('dawn');
    const headers = (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-model']).toBe('claude-fable-5');
  });

  it('attests the caller-resolved model when the env declares nothing at all (ADR 246)', async () => {
    // The case that was silently losing: no MUSTERD_MODEL in a hook's environment, but an
    // observation on disk. Before, this sent no header and the occupancy was born unattested.
    const fn = stubOkFetch();
    await new HttpClient({
      server: 'http://x',
      key: 'msac_agent',
      seat: 'Ada',
      sessionLease: 'msls_presence',
      surface: 'cli',
      model: 'claude-fable-5',
    }).roster('dawn');
    const headers = (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-model']).toBe('claude-fable-5');
  });

  it('a caller-resolved model still never rides a human credential (ADR 121 outranks ADR 246)', async () => {
    // The gate is on the CREDENTIAL, not on where the value came from. Resolving a model more
    // thoroughly must not create a new way for a human shell to stamp an occupancy.
    const fn = stubOkFetch();
    await new HttpClient({
      server: 'http://x',
      key: 'mscr_human',
      seat: 'nick',
      surface: 'cli',
      model: 'claude-fable-5',
    }).roster('dawn');
    const headers = (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-musterd-model']).toBeUndefined();
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
