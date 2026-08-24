import { z } from 'zod';

/** ADR 291: a captured Team idea before it becomes (or deliberately does not become) a Lane. */
export const SeedStateSchema = z.enum([
  'open',
  'exploring',
  'needs_clarification',
  'clarified',
  'completed',
  'promoted',
]);
export type SeedState = z.infer<typeof SeedStateSchema>;

export const SeedSourceSchema = z.enum(['slack', 'sms']);
export type SeedSource = z.infer<typeof SeedSourceSchema>;

export const SeedThreadEntryKindSchema = z.enum(['clarification', 'answer', 'brief', 'conclusion']);
export type SeedThreadEntryKind = z.infer<typeof SeedThreadEntryKindSchema>;

/** The narrow public thread attached to a Seed; raw source remains immutable on the Seed itself. */
export const SeedThreadEntrySchema = z.object({
  id: z.string().min(1),
  kind: SeedThreadEntryKindSchema,
  body: z.string().trim().min(1),
  by: z.string().min(1),
  created_at: z.number().int().nonnegative(),
});
export type SeedThreadEntry = z.infer<typeof SeedThreadEntrySchema>;

export const SeedSchema = z.object({
  id: z.string().min(1),
  team: z.string().min(1),
  relay_id: z.string().min(1),
  source: SeedSourceSchema,
  body: z.string(),
  captured_at: z.number().int().nonnegative(),
  submitted_by: z.string().min(1),
  state: SeedStateSchema,
  explorer: z.string().min(1).nullable(),
  thread: z.array(SeedThreadEntrySchema),
  conclusion: z.string().nullable(),
  linked_lane_id: z.string().min(1).nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
export type Seed = z.infer<typeof SeedSchema>;

export const ClaimSeedSchema = z.object({});
export type ClaimSeed = z.infer<typeof ClaimSeedSchema>;

export const AskSeedClarificationSchema = z.object({ body: z.string().trim().min(1) });
export type AskSeedClarification = z.infer<typeof AskSeedClarificationSchema>;

export const AnswerSeedClarificationSchema = z.object({ body: z.string().trim().min(1) });
export type AnswerSeedClarification = z.infer<typeof AnswerSeedClarificationSchema>;

export const ConcludeSeedSchema = z.object({ conclusion: z.string().trim().min(1) });
export type ConcludeSeed = z.infer<typeof ConcludeSeedSchema>;

export const PromoteSeedSchema = z.object({
  title: z.string().trim().min(1),
  detail: z.string().trim().min(1),
});
export type PromoteSeed = z.infer<typeof PromoteSeedSchema>;

export const SeedResultSchema = z.object({ seed: SeedSchema });
export type SeedResult = z.infer<typeof SeedResultSchema>;

export const SeedListSchema = z.object({ seeds: z.array(SeedSchema) });
export type SeedList = z.infer<typeof SeedListSchema>;
