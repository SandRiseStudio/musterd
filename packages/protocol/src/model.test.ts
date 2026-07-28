import { describe, expect, it } from 'vitest';
import {
  describeFamilyPosture,
  MODEL_UNKNOWN,
  modelFamily,
  resolveAttestation,
  resolveAttestedModel,
} from './model.js';

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

describe('describeFamilyPosture (ADR 172) — one bounded line', () => {
  const base = {
    attesting: 0,
    families: {},
    unattested: 0,
    wake_pool: [],
    humans_live: 0,
    computed_at: 1,
  };

  it('monoculture names the family, the count, and the remedy pool', () => {
    const line = describeFamilyPosture({
      ...base,
      state: 'monoculture',
      attesting: 3,
      families: { claude: 3 },
      wake_pool: ['dolly', 'grokbot', 'gptbot', 'kimi', 'compo'],
      humans_live: 1,
    });
    expect(line).toContain('monoculture — 3 agents attesting, all claude');
    expect(line).toContain('idle & enrollable: dolly, grokbot, gptbot +2');
    expect(line).toContain('1 human(s) live');
    expect(line).not.toContain('kimi'); // bounded: never one entry per seat
  });

  it('diverse lists family counts', () => {
    expect(
      describeFamilyPosture({
        ...base,
        state: 'diverse',
        attesting: 4,
        families: { claude: 3, gpt: 1 },
      }),
    ).toContain('diverse — claude×3, gpt×1');
  });

  it('unknown says why — zero attesting vs one attesting are different sentences', () => {
    expect(describeFamilyPosture({ ...base, state: 'unknown' })).toContain(
      'no agents attesting a known family',
    );
    expect(
      describeFamilyPosture({ ...base, state: 'unknown', attesting: 1, families: { claude: 1 } }),
    ).toContain('only 1 agent attesting a known family');
  });
});
