import { describe, expect, it } from 'vitest';
import { MODEL_UNKNOWN, modelFamily, resolveAttestation, resolveAttestedModel } from './model.js';

describe('modelFamily (ADR 101)', () => {
  it('derives the family as the leading alphabetic token, lowercased', () => {
    expect(modelFamily('claude-opus-4-8')).toBe('claude');
    expect(modelFamily('Claude-Sonnet-5')).toBe('claude');
    expect(modelFamily('gpt-5.2-codex')).toBe('gpt');
    expect(modelFamily('gemini-3-pro')).toBe('gemini');
  });

  it('degrades to unknown on missing/empty/non-alphabetic ids — never guesses', () => {
    expect(modelFamily(null)).toBe(MODEL_UNKNOWN);
    expect(modelFamily(undefined)).toBe(MODEL_UNKNOWN);
    expect(modelFamily('')).toBe(MODEL_UNKNOWN);
    expect(modelFamily('   ')).toBe(MODEL_UNKNOWN);
    expect(modelFamily('4.5-turbo')).toBe(MODEL_UNKNOWN);
    expect(modelFamily(MODEL_UNKNOWN)).toBe(MODEL_UNKNOWN);
  });
});

describe('resolveAttestedModel (ADR 101)', () => {
  it('prefers MUSTERD_MODEL, falls back to ANTHROPIC_MODEL, undefined when neither', () => {
    expect(
      resolveAttestedModel({ MUSTERD_MODEL: 'gpt-5.2', ANTHROPIC_MODEL: 'claude-opus-4-8' }),
    ).toBe('gpt-5.2');
    expect(resolveAttestedModel({ ANTHROPIC_MODEL: ' claude-opus-4-8 ' })).toBe('claude-opus-4-8');
    expect(resolveAttestedModel({})).toBeUndefined();
    expect(resolveAttestedModel({ MUSTERD_MODEL: '   ' })).toBeUndefined();
  });

  it('caps the attested id at 120 chars (the wire limit)', () => {
    expect(resolveAttestedModel({ MUSTERD_MODEL: 'x'.repeat(200) })).toHaveLength(120);
  });
});

describe('resolveAttestation — observation beats declaration', () => {
  const obs = (model: string) => ({ model, harness: 'claude-code', observed_at: 1 });

  it('prefers an observation over both declarations, and reports the drift', () => {
    expect(
      resolveAttestation({
        observed: obs('claude-opus-4-8'),
        env: 'grok-4.5',
        binding: 'grok-4.5',
      }),
    ).toEqual({
      model: 'claude-opus-4-8',
      source: 'observed',
      drift: true,
      declared: 'grok-4.5',
    });
  });

  it('reports no drift when the observation agrees with the declaration', () => {
    expect(
      resolveAttestation({ observed: obs('claude-opus-4-8'), env: 'claude-opus-4-8' }).drift,
    ).toBe(false);
  });

  it('reports no drift when nothing was declared — an unattested seat is not drifting', () => {
    expect(resolveAttestation({ observed: obs('claude-opus-4-8') })).toEqual({
      model: 'claude-opus-4-8',
      source: 'observed',
      drift: false,
      declared: undefined,
    });
  });

  it('compares the observation against env FIRST — the rung that outranked everything', () => {
    // The incident shape: a stale MUSTERD_MODEL baked into the MCP entry, binding agreeing with truth.
    const r = resolveAttestation({
      observed: obs('claude-opus-4-8'),
      env: 'grok-4.5',
      binding: 'claude-opus-4-8',
    });
    expect(r.drift).toBe(true);
    expect(r.declared).toBe('grok-4.5');
  });

  it('falls back to env, then binding, within the declared tier', () => {
    expect(resolveAttestation({ env: 'grok-4.5', binding: 'other' })).toEqual({
      model: 'grok-4.5',
      source: 'environment',
      drift: false,
      declared: undefined,
    });
    expect(resolveAttestation({ binding: 'grok-4.5' })).toEqual({
      model: 'grok-4.5',
      source: 'binding',
      drift: false,
      declared: undefined,
    });
  });

  it('degrades to unknown when nothing declares or observes', () => {
    expect(resolveAttestation({})).toEqual({
      model: undefined,
      source: 'unknown',
      drift: false,
      declared: undefined,
    });
  });
});
