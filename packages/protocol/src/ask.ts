import { z } from 'zod';

/**
 * The to-human ask stream (musterd/0.3, ADR 147 — item 2 of the human-role re-founding, ADR 145 §3.1).
 * One act (`ask`, appended to `ACTS`) carries directed-to-human traffic in three **species**, and each
 * ask carries a **tier** that owns the clock: the tier derives a timeout and a no-answer policy, so the
 * *agent* — never a server timer — knows how long to wait and what to do when no answer comes.
 *
 * The design's two load-bearing invariants (ADR 145 §3.1) fall out of the tier ordering by construction:
 * **only the top tier can wedge** (its no-answer policy is `hold`), and **everything below it turns human
 * silence into an auditable risk-acceptance** (`proceed_with_risk`), never a silent stall.
 */

/**
 * The three species of a to-human ask (ADR 147 §1). A discriminator on one act, not three acts — the
 * "one stream" the design names.
 * - `consult` — "what do you think / which direction." Not an emergency; wanted even in full-auto.
 * - `escalate` — a true blocker or dispute only a human can settle.
 * - `approve` — the admin gate (costly/destructive/out-of-scope). Seat *admission* keeps its specialized
 *   request lane (ADR 077); this is the general approval the requests table never modelled.
 */
export const ASK_SPECIES = ['consult', 'escalate', 'approve'] as const;
export type AskSpecies = (typeof ASK_SPECIES)[number];
export const AskSpeciesSchema = z.enum(ASK_SPECIES);

/**
 * The tier scale, **ordered low→high** — the last entry is the top tier (the only one that holds). Kept
 * short and named (a shipped default spectrum, not an infinite knob — the founder's everything-
 * configurable instinct, held to a default, ADR 145 Appendix A). `blocking` = extremely costly/
 * destructive; `standard`/`advisory` = the below-top spectrum that scales by importance.
 */
export const ASK_TIERS = ['advisory', 'standard', 'blocking'] as const;
export type AskTier = (typeof ASK_TIERS)[number];
export const AskTierSchema = z.enum(ASK_TIERS);

/** The two no-answer policies (ADR 147 §2). Derived from tier — never stored on the ask. */
export const ASK_NO_ANSWER = ['hold', 'proceed_with_risk'] as const;
export type AskNoAnswer = (typeof ASK_NO_ANSWER)[number];

/** The terminal no-answer outcomes an agent records (ADR 147 §4), carried on a `status_update`'s meta. */
export const ASK_OUTCOMES = ['held', 'risk_accepted'] as const;
export type AskOutcome = (typeof ASK_OUTCOMES)[number];
export const AskOutcomeSchema = z.enum(ASK_OUTCOMES);

/** The tier contract: how long the agent waits, and what it does when the wait elapses unanswered. */
export interface AskContract {
  timeout_ms: number;
  no_answer: AskNoAnswer;
}

/**
 * The shipped default spectrum (ADR 147 §2) — the ONE place tier→contract lives, so every surface derives
 * the same numbers. The top tier (`ASK_TIERS[last]`) holds; all others proceed with a recorded risk.
 */
export const ASK_TIER_DEFAULTS: Record<AskTier, AskContract> = {
  advisory: { timeout_ms: 3 * 60_000, no_answer: 'proceed_with_risk' },
  standard: { timeout_ms: 5 * 60_000, no_answer: 'proceed_with_risk' },
  blocking: { timeout_ms: 15 * 60_000, no_answer: 'hold' },
};

/** The top (holding) tier — the last (highest) entry, the only tier whose no-answer policy is `hold`. */
export const ASK_TOP_TIER = ASK_TIERS[ASK_TIERS.length - 1] as AskTier;

/** True iff this tier is the top tier — i.e. an unanswered ask at this tier holds rather than proceeds. */
export function askTierHolds(tier: AskTier): boolean {
  return ASK_TIER_DEFAULTS[tier].no_answer === 'hold';
}

/** The contract for a tier: the timeout the agent waits, and the policy it then invokes. */
export function askContract(tier: AskTier): AskContract {
  return ASK_TIER_DEFAULTS[tier];
}
