import { describe, expect, it } from 'vitest';
import type { findBinding } from '../config.js';
import { attestedModel } from './helpers.js';

type Binding = ReturnType<typeof findBinding>;

/**
 * ADR 246. The CLI attested from `MUSTERD_MODEL`/`ANTHROPIC_MODEL` alone — the WEAKEST tier of the
 * ADR 158 ladder, and the one a hook process is least likely to carry. So an ambient touch from a
 * SessionStart hook routinely attested nothing while the harness's own observation sat in
 * `binding.model_observed`, seconds old. That unattested row is the newest non-held presence, so
 * `latestAttestedModel` reads its null and the seat silently leaves the ADR 188 review pool.
 *
 * Measured on seat miley, 2026-08-05: `model_observed: claude-fable-5` stamped at 17:47:02, and a
 * presence row with `model = null` created at 17:47:14 — twelve seconds later.
 */
describe('attestedModel — the CLI shares the MCP adapter’s ADR 158 ladder (ADR 246)', () => {
  const bindingWith = (over: Record<string, unknown>): Binding =>
    ({ server: 'http://x', team: 'dawn', ...over }) as unknown as Binding;

  it('prefers a hook observation over both declarations — the tier the CLI could not see', () => {
    const model = attestedModel(
      bindingWith({
        model: 'claude-opus-5',
        model_observed: { model: 'claude-fable-5', harness: 'claude-code', observed_at: 1 },
      }),
      { MUSTERD_MODEL: 'claude-opus-4-8' },
    );
    expect(model).toBe('claude-fable-5');
  });

  it('attests the binding declaration when nothing is in the env — the case that lost silently', () => {
    // A hook one-shot with an empty environment. Before ADR 246 this attested NOTHING and the
    // occupancy was born unattested; the seat's own binding knew the answer the whole time.
    expect(attestedModel(bindingWith({ model: 'claude-fable-5' }), {})).toBe('claude-fable-5');
  });

  it('still lets the env outrank a stale binding declaration', () => {
    expect(
      attestedModel(bindingWith({ model: 'claude-opus-4-8' }), { MUSTERD_MODEL: 'claude-opus-5' }),
    ).toBe('claude-opus-5');
  });

  it('attests nothing when no tier has anything — unknown stays legal and never blocks', () => {
    expect(attestedModel(bindingWith({}), {})).toBeUndefined();
    expect(attestedModel(undefined as unknown as Binding, {})).toBeUndefined();
  });
});
