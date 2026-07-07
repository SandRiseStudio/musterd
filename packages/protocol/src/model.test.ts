import { describe, expect, it } from 'vitest';
import { MODEL_UNKNOWN, modelFamily, resolveAttestedModel } from './model.js';

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
