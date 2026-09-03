import { describe, expect, it } from 'vitest';
import { SURFACES } from './acts.js';
import {
  describeFamilyPosture,
  MODEL_UNKNOWN,
  modelFamily,
  normalizeModelId,
  isProbeCapableSurface,
  PROBE_CAPABLE_SURFACES,
  resolveAttestation,
  reviewGrade,
  shouldWarnUnobservedModel,
  resolveAttestedModel,
  wakeabilityFromFacts,
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

describe('probe-capable surfaces (ADR 101/158 follow-up)', () => {
  it('names only surfaces that exist — the list cannot drift off the Surface vocabulary', () => {
    for (const s of PROBE_CAPABLE_SURFACES) expect(SURFACES).toContain(s);
  });

  it('is false for the surfaces with no probe to miss, and for junk', () => {
    for (const s of ['cli', 'web', 'ios', 'slack', 'other', 'musterd']) {
      expect(isProbeCapableSurface(s)).toBe(false);
    }
    expect(isProbeCapableSurface(undefined)).toBe(false);
    expect(isProbeCapableSurface(null)).toBe(false);
    expect(isProbeCapableSurface('')).toBe(false);
  });
});

describe('shouldWarnUnobservedModel — a declaration where an observation was reachable', () => {
  it('warns on every probe-capable surface that resolved a declared tier', () => {
    for (const s of PROBE_CAPABLE_SURFACES) {
      expect(shouldWarnUnobservedModel(s, 'binding')).toBe(true);
      expect(shouldWarnUnobservedModel(s, 'environment')).toBe(true);
    }
  });

  it('stays silent when the tier is already observed — that is the goal state', () => {
    for (const s of PROBE_CAPABLE_SURFACES) {
      expect(shouldWarnUnobservedModel(s, 'observed')).toBe(false);
    }
  });

  it('stays silent on unknown: nothing was declared, so there is no snapshot to distrust', () => {
    expect(shouldWarnUnobservedModel('claude-code', 'unknown')).toBe(false);
  });

  it('stays silent on a surface with no probe — a declaration is its honest best', () => {
    expect(shouldWarnUnobservedModel('cli', 'binding')).toBe(false);
    expect(shouldWarnUnobservedModel('slack', 'environment')).toBe(false);
    expect(shouldWarnUnobservedModel(undefined, 'binding')).toBe(false);
  });
});

describe('wakeabilityFromFacts (ADR 189)', () => {
  it('unenrolled is not_enrolled — host facts never override that', () => {
    expect(wakeabilityFromFacts({ enrolled: false })).toBe('not_enrolled');
    expect(
      wakeabilityFromFacts({ enrolled: false, workspace_readable: false, host_reachable: false }),
    ).toBe('not_enrolled');
  });

  it('enrolled with no host defects is wakeable', () => {
    expect(wakeabilityFromFacts({ enrolled: true })).toBe('wakeable');
    expect(wakeabilityFromFacts({ enrolled: true, workspace_readable: true })).toBe('wakeable');
  });

  it('host refinements only apply to enrolled seats', () => {
    expect(wakeabilityFromFacts({ enrolled: true, workspace_readable: false })).toBe(
      'enrolled_dead_workspace',
    );
    expect(wakeabilityFromFacts({ enrolled: true, host_reachable: false })).toBe(
      'enrolled_host_stale',
    );
    // Dead workspace wins over host_stale — the operator's next move is the registry pointer.
    expect(
      wakeabilityFromFacts({
        enrolled: true,
        workspace_readable: false,
        host_reachable: false,
      }),
    ).toBe('enrolled_dead_workspace');
  });

  it('a seat the audit says is mid-something is marked busy, not wakeable (ADR 219)', () => {
    expect(wakeabilityFromFacts({ enrolled: true, seat_quiet: false })).toBe('enrolled_seat_busy');
    expect(wakeabilityFromFacts({ enrolled: true, seat_quiet: true })).toBe('wakeable');
  });

  it('omitted quiescence changes nothing — unknown is not evidence of quiet (ADR 169/189)', () => {
    expect(wakeabilityFromFacts({ enrolled: true })).toBe('wakeable');
    expect(wakeabilityFromFacts({ enrolled: true, seat_quiet: undefined })).toBe('wakeable');
  });

  it('busy is the softest reason — every reachability defect outranks it', () => {
    // A busy-but-unreachable seat must name the defect the operator can act on, not "busy".
    expect(wakeabilityFromFacts({ enrolled: false, seat_quiet: false })).toBe('not_enrolled');
    expect(
      wakeabilityFromFacts({ enrolled: true, workspace_readable: false, seat_quiet: false }),
    ).toBe('enrolled_dead_workspace');
    expect(wakeabilityFromFacts({ enrolled: true, host_reachable: false, seat_quiet: false })).toBe(
      'enrolled_host_stale',
    );
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
      // ADR 187 + 189: wakeable cross-family first; unenrolled cross-family still named but marked.
      wake_pool: [
        { seat: 'dolly', family: 'claude', attested_at: NOW - 3_600_000, wakeability: 'wakeable' },
        {
          seat: 'grokbot',
          family: 'grok',
          attested_at: NOW - 86_400_000 * 21,
          wakeability: 'wakeable',
        },
        {
          seat: 'gptbot',
          family: 'gpt',
          attested_at: NOW - 86_400_000 * 21,
          wakeability: 'wakeable',
        },
        { seat: 'kimi', family: 'unknown', attested_at: null, wakeability: 'not_enrolled' },
        {
          seat: 'compo',
          family: 'composer',
          attested_at: NOW - 3_600_000 * 5,
          wakeability: 'wakeable',
        },
      ],
      humans_live: 1,
    });
    expect(line).toContain('monoculture — 3 agents attesting, all claude');
    expect(line).toContain('idle: grokbot (grok, 21d ago)');
    expect(line).toContain('gptbot (gpt, 21d ago)');
    expect(line).toContain('compo (composer, 5h ago)');
    expect(line).toContain('+2');
    expect(line).toContain('1 human(s) live');
    expect(line).not.toContain('kimi'); // bounded: never one entry per seat
    expect(line).not.toContain('dolly'); // a same-family seat is not the remedy
  });

  it('prefers a wakeable same-family seat over an unenrolled cross-family one for the spend slots', () => {
    // ADR 189: mark-not-filter — grokbot stays visible in the pool, but the bounded line spends its
    // first slots on seats dispatch can actually wake.
    const line = describeFamilyPosture({
      ...base,
      state: 'monoculture',
      attesting: 2,
      families: { claude: 2 },
      wake_pool: [
        {
          seat: 'grokbot',
          family: 'grok',
          attested_at: NOW - 86_400_000,
          wakeability: 'not_enrolled',
        },
        { seat: 'miley', family: 'claude', attested_at: NOW - 3_600_000, wakeability: 'wakeable' },
      ],
    });
    expect(line).toContain('idle: miley (claude, 1h ago)');
    expect(line).toContain('grokbot (grok, 24h ago, not_enrolled)');
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
