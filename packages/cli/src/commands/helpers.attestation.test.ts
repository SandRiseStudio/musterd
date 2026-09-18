import { describe, expect, it } from 'vitest';
import type { findBinding } from '../config.js';
import { attestedAttestation, attestedModel } from './helpers.js';

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

/**
 * ADR 301 / lane 01M2RTF2D0. `resolveAttestation` returns `{model, source}` — the ladder computes
 * WHICH RUNG answered as an inseparable part of answering. `attestedModel` kept `.model` and dropped
 * `.source` on the next line, and that single discard is the whole defect: from there no CLI surface
 * could name the tier, because by the time the value reached the transport the evidence class had
 * already been erased.
 *
 * The tier is not a nicety. ADR 158's rule is "an observation outranks a declaration"; the roster
 * ranks on `Presence.model_source`. A CLI-claimed seat reporting null ranks BELOW a seat whose
 * harness merely declared the same model — the ladder inverted by the one field that says which
 * rung it came from.
 */
describe('attestedAttestation — the tier survives the ladder (ADR 301, lane 01M2RTF2D0)', () => {
  const bindingWith = (over: Record<string, unknown>): Binding =>
    ({ server: 'http://x', team: 'dawn', ...over }) as unknown as Binding;

  it('names `observed` when a hook observation answered', () => {
    expect(
      attestedAttestation(
        bindingWith({
          model: 'claude-opus-5',
          model_observed: { model: 'claude-fable-5', harness: 'claude-code', observed_at: 1 },
        }),
        { MUSTERD_MODEL: 'claude-opus-4-8' },
      ),
    ).toEqual({ model: 'claude-fable-5', source: 'observed' });
  });

  it('names `environment` when the env declaration answered', () => {
    expect(attestedAttestation(bindingWith({}), { MUSTERD_MODEL: 'claude-opus-5' })).toEqual({
      model: 'claude-opus-5',
      source: 'environment',
    });
  });

  it('names `binding` when the provisioning snapshot answered', () => {
    expect(attestedAttestation(bindingWith({ model: 'claude-fable-5' }), {})).toEqual({
      model: 'claude-fable-5',
      source: 'binding',
    });
  });

  /** `unknown` is the ladder's own word for "no rung answered", and it is NOT a wire value — the
   *  frame omits the field instead, so the row records null rather than the string "unknown". */
  it('returns no tier at all when nothing answered — absent, never the string `unknown`', () => {
    expect(attestedAttestation(bindingWith({}), {})).toEqual({
      model: undefined,
      source: undefined,
    });
  });

  it('agrees with attestedModel on the id, always — one resolve, two readings', () => {
    const binding = bindingWith({
      model: 'claude-opus-5',
      model_observed: { model: 'claude-fable-5', harness: 'claude-code', observed_at: 1 },
    });
    const env = { MUSTERD_MODEL: 'claude-opus-4-8' };
    expect(attestedAttestation(binding, env).model).toBe(attestedModel(binding, env));
  });
});
