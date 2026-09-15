import { z } from 'zod';

/**
 * Guardian incident classes and autonomy tiers (2026-08-13 guardian spec §4). The tier map is a
 * team-policy knob — an admin flips a class between observe/alert/auto without a release; the
 * shipped defaults live with the classifier (`packages/cli/src/guardian/classify.ts`), applied at
 * READ time so `parse({})` stays sparse (the ADR 185 defaults-on-read posture).
 */
export const GUARDIAN_CLASSES = [
  'publisher_failed',
  'crashloop',
  'daemon_down',
  /**
   * Alive but unreachable, PROVEN by a bounded stack sample (ADR 389 §1) — not merely inferred
   * from an unanswered /health. Its own class rather than a policy footnote on `daemon_down`
   * because the tier attaches to the class: the destructive tier cannot be pointed at an incident
   * whose evidence does not support it, and that standard is then enforced by the type rather
   * than by a reviewer remembering it. Ships at `alert`, like `daemon_down`.
   */
  'daemon_wedged',
  /**
   * Alive, unreachable, and the MACHINE is the reason (lane 01M2GTB0RA, 2026-09-14): the load
   * average is well past the core count, so a single-threaded daemon whose every db call is
   * synchronous cannot get a slot inside the probe's bound. Six pages in one afternoon were this —
   * other seats' tsc and vitest, opencode, the daemon itself — each cleared by the next autorefresh
   * bounce, none a block. The stack sample cannot separate starved from blocked (a busy sync daemon
   * is always inside some frame); the load average can. Ships at `observe`: a human cannot fix
   * load by being paged about it, and the page was training seats to clear real ones on sight.
   */
  'daemon_starved',
  'schema_drift',
  'wrong_db',
  'error_rate',
  'presence_churn',
] as const;

export const GuardianClassSchema = z.enum(GUARDIAN_CLASSES);
export type GuardianClass = z.infer<typeof GuardianClassSchema>;

export const GuardianTierSchema = z.enum(['observe', 'alert', 'auto']);
export type GuardianTier = z.infer<typeof GuardianTierSchema>;

/** Sparse per-class overrides — absent classes fall to the shipped defaults at read time. */
export const GuardianTiersSchema = z.record(GuardianClassSchema, GuardianTierSchema);
export type GuardianTiers = z.infer<typeof GuardianTiersSchema>;
