import { describe, expect, it } from 'vitest';
import {
  describeFamilyPosture,
  MODEL_UNKNOWN,
  modelFamily,
  normalizeModelId,
  resolveAttestation,
  reviewGrade,
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
  const NOW = Date.now();
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
      // ADR 187: cross-family candidates sort FIRST, so the three slots go to the seats that would
      // actually change the posture — `dolly` is another claude and must lose its slot to them.
      wake_pool: [
        { seat: 'dolly', family: 'claude', attested_at: NOW - 3_600_000 },
        { seat: 'grokbot', family: 'grok', attested_at: NOW - 86_400_000 * 21 },
        { seat: 'gptbot', family: 'gpt', attested_at: NOW - 86_400_000 * 21 },
        { seat: 'kimi', family: 'unknown', attested_at: null },
        { seat: 'compo', family: 'composer', attested_at: NOW - 3_600_000 * 5 },
      ],
      humans_live: 1,
    });
    expect(line).toContain('monoculture — 3 agents attesting, all claude');
    expect(line).toContain('idle & enrollable: grokbot (grok, 21d ago)');
    expect(line).toContain('gptbot (gpt, 21d ago)');
    expect(line).toContain('compo (composer, 5h ago)');
    expect(line).toContain('+2');
    expect(line).toContain('1 human(s) live');
    expect(line).not.toContain('kimi'); // bounded: never one entry per seat
    expect(line).not.toContain('dolly'); // a same-family seat is not the remedy
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

describe('reviewGrade (ADR 188) — the diversity spectrum', () => {
  it('normalizeModelId strips a trailing date stamp and nothing else', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol'); // no date — untouched
    expect(normalizeModelId('  Claude-Opus-5 ')).toBe('claude-opus-5');
    expect(normalizeModelId('')).toBe(MODEL_UNKNOWN);
    expect(normalizeModelId(null)).toBe(MODEL_UNKNOWN);
  });

  it('grades the spectrum: family beats model beats identity', () => {
    expect(reviewGrade('claude-opus-5', 'gpt-5.6-sol')).toBe('cross_family');
    expect(reviewGrade('claude-opus-5', 'claude-opus-4-8')).toBe('cross_model');
    expect(reviewGrade('claude-opus-5', 'claude-fable-5')).toBe('cross_model');
    expect(reviewGrade('claude-opus-5', 'claude-opus-5')).toBe('same_model');
  });

  it('a date-stamped ID is the same model, not a different one', () => {
    expect(reviewGrade('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe('same_model');
  });

  it('unknown on either side grades nothing — null, never a guess', () => {
    expect(reviewGrade('claude-opus-5', null)).toBeNull();
    expect(reviewGrade(undefined, 'claude-opus-5')).toBeNull();
    expect(reviewGrade('unknown', 'claude-opus-5')).toBeNull();
  });
});
