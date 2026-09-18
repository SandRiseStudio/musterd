import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRead } from './helpers.js';

/**
 * The WIRING test, and it exists because its absence is the defect's own shape.
 *
 * Lane 01M2RTF2D0 is one more instance of "resolved at every call, passed at none" — the family
 * `workspaceKey` belongs to (lane 01M1T29EV9), and `provenance` on the stateless mirror before it.
 * In every case the unit tests either side of the boundary were green: the resolver returned the
 * right answer, the builder forwarded what it was handed, and the two were simply never joined.
 *
 * Measured here, 2026-09-17: with `attestedAttestation` and `identityClientOpts` both tested
 * directly, neutralising `gather()`'s tier to `undefined` left all 15 of those tests passing. Tests
 * that sit on either side of a seam cannot see the seam. So this one starts where the fact really
 * starts — a binding on disk carrying a harness observation — and ends where it has to arrive: the
 * header on the wire.
 */
describe('binding observation → wire tier, end to end (ADR 301, lane 01M2RTF2D0)', () => {
  let workspace: string;
  let cwd: string;

  const writeBinding = (over: Record<string, unknown>) => {
    mkdirSync(join(workspace, '.musterd'), { recursive: true });
    writeFileSync(
      join(workspace, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://127.0.0.1:1',
        team: 'dawn',
        claim: { mode: 'seat', name: 'Ada' },
        seat_credential: 'msac_test1234567890abcdef',
        ...over,
      }),
    );
  };

  /** Capture the headers of the first fetch the resolved client makes. */
  const stubOkFetch = () => {
    const fn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ members: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  const headersOf = (fn: ReturnType<typeof stubOkFetch>) =>
    (fn.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'musterd-attest-seam-'));
    cwd = process.cwd();
    process.chdir(workspace);
    delete process.env['MUSTERD_MODEL'];
    delete process.env['ANTHROPIC_MODEL'];
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(workspace, { recursive: true, force: true });
    vi.unstubAllGlobals();
    delete process.env['MUSTERD_MODEL'];
    delete process.env['ANTHROPIC_MODEL'];
  });

  it('a hook observation on disk reaches the wire as `observed`', async () => {
    writeBinding({
      model: 'claude-opus-5',
      model_observed: { model: 'claude-fable-5', harness: 'claude-code', observed_at: 1 },
    });
    const fn = stubOkFetch();
    await resolveRead({}).http.roster('dawn');
    const headers = headersOf(fn);
    expect(headers['x-musterd-model']).toBe('claude-fable-5');
    expect(headers['x-musterd-model-source']).toBe('observed');
  });

  /**
   * The rung that matters most for ADR 158: a binding DECLARATION must not present itself with the
   * confidence of an observation. Before this, both arrived as a bare id and were indistinguishable
   * on the roster — which is the aggregate mixing measurements with assumptions that ADR 301 names.
   */
  it('a binding declaration reaches the wire as `binding`, not as an observation', async () => {
    writeBinding({ model: 'claude-opus-5' });
    const fn = stubOkFetch();
    await resolveRead({}).http.roster('dawn');
    const headers = headersOf(fn);
    expect(headers['x-musterd-model']).toBe('claude-opus-5');
    expect(headers['x-musterd-model-source']).toBe('binding');
  });

  it('an env declaration reaches the wire as `environment`', async () => {
    writeBinding({});
    process.env['MUSTERD_MODEL'] = 'qwen2.5:3b-instruct';
    const fn = stubOkFetch();
    await resolveRead({}).http.roster('dawn');
    const headers = headersOf(fn);
    expect(headers['x-musterd-model']).toBe('qwen2.5:3b-instruct');
    expect(headers['x-musterd-model-source']).toBe('environment');
  });

  it('a workspace that attests nothing sends neither — unknown stays legal', async () => {
    writeBinding({});
    const fn = stubOkFetch();
    await resolveRead({}).http.roster('dawn');
    const headers = headersOf(fn);
    expect(headers['x-musterd-model']).toBeUndefined();
    expect(headers['x-musterd-model-source']).toBeUndefined();
  });
});
