import { describe, expect, it } from 'vitest';
import {
  ASK_SPECIES,
  ASK_TIERS,
  ASK_TIER_DEFAULTS,
  ASK_TOP_TIER,
  askContract,
  askTierHolds,
} from './ask.js';

describe('the ask tier contract (ADR 147 §2)', () => {
  it('has a contract for every tier, in one place', () => {
    for (const tier of ASK_TIERS) {
      expect(ASK_TIER_DEFAULTS[tier]).toBeDefined();
      expect(askContract(tier)).toEqual(ASK_TIER_DEFAULTS[tier]);
    }
  });

  it('exactly the top tier holds; all others proceed with risk', () => {
    // The load-bearing invariant: only the top tier can wedge (ADR 147 §2 / ADR 145 §3.1).
    expect(ASK_TOP_TIER).toBe(ASK_TIERS[ASK_TIERS.length - 1]);
    expect(askTierHolds(ASK_TOP_TIER)).toBe(true);
    for (const tier of ASK_TIERS) {
      const holds = tier === ASK_TOP_TIER;
      expect(askTierHolds(tier)).toBe(holds);
      expect(askContract(tier).no_answer).toBe(holds ? 'hold' : 'proceed_with_risk');
    }
    // Exactly one holding tier — no ambiguity about which tier wedges.
    expect(ASK_TIERS.filter(askTierHolds)).toHaveLength(1);
  });

  it('timeouts scale up with importance (advisory < standard < blocking)', () => {
    const t = ASK_TIERS.map((tier) => askContract(tier).timeout_ms);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]!);
    // The founder's illustrative numbers (ADR 145 A5): ~3m clarification floor, ~15m top.
    expect(askContract('advisory').timeout_ms).toBe(3 * 60_000);
    expect(askContract('blocking').timeout_ms).toBe(15 * 60_000);
  });

  it('names exactly the three species the design fixes', () => {
    expect([...ASK_SPECIES]).toEqual(['consult', 'escalate', 'approve']);
  });
});
