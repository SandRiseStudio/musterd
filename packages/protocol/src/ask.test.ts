import { describe, expect, it } from 'vitest';
import {
  ASK_SPECIES,
  ASK_TIERS,
  ASK_TIER_DEFAULTS,
  ASK_TOP_TIER,
  askContract,
  askContractText,
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

describe('askContractText — the one canonical ask contract phrasing (ADR 147 §2/§4)', () => {
  it('the top tier tells the agent to HOLD and record the held outcome, never proceed', () => {
    const text = askContractText('ask-1', ASK_TOP_TIER);
    expect(text).toContain('HOLD');
    expect(text).toContain('do NOT proceed');
    // The held-outcome recording (ADR 147 §4) — the part MCP's old text omitted.
    expect(text).toContain("meta.ask_outcome='held'");
    expect(text).toContain('ask-1'); // the ask id is threaded in
    expect(text).toContain('15m'); // the blocking timeout, derived from ASK_TIER_DEFAULTS
    expect(text).not.toContain('risk_accepted'); // top tier never risk-proceeds
  });

  it('a below-top tier tells the agent it may PROCEED with a recorded risk-acceptance', () => {
    const text = askContractText('ask-2', 'advisory');
    expect(text).toContain('PROCEED');
    expect(text).toContain("meta.ask_outcome='risk_accepted'");
    expect(text).toContain('meta.chosen_approach');
    expect(text).not.toContain('HOLD');
    expect(text).toContain('3m'); // advisory timeout
  });

  it('derives its minutes from askContract, so the text and the clock never disagree', () => {
    for (const tier of ASK_TIERS) {
      const mins = Math.round(askContract(tier).timeout_ms / 60_000);
      expect(askContractText('x', tier)).toContain(`${mins}m`);
    }
  });
});
