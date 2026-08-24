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

export const SeedSourceSchema = z.literal('slack');
export type SeedSource = z.infer<typeof SeedSourceSchema>;

/** Raw relay boundary accepted by shared-Seed ingest (ADR 311). */
export const RelaySeedSchema = z.object({
  id: z.string().min(1),
  body: z
    .string()
    .refine((body) => body.trim().length > 0, 'body must contain non-whitespace text'),
  ts: z.number().int().nonnegative(),
  source: SeedSourceSchema,
  meta: z.object({ user: z.string().min(1) }).passthrough(),
});
export type RelaySeed = z.infer<typeof RelaySeedSchema>;

export const RelaySeedListSchema = z.object({ seeds: z.array(RelaySeedSchema) });
export type RelaySeedList = z.infer<typeof RelaySeedListSchema>;

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

export const SeedBriefSchema = z.object({
  problem: z.string().trim().min(1),
  context: z.string().trim().min(1),
  external_evidence: z.array(z.string().trim().min(1)),
  approaches: z
    .array(
      z.object({
        approach: z.string().trim().min(1),
        tradeoffs: z.string().trim().min(1),
      }),
    )
    .min(1),
  constraints: z.array(z.string().trim().min(1)),
  risks: z.array(z.string().trim().min(1)),
  unknowns: z.array(z.string().trim().min(1)),
  recommendation: z.string().trim().min(1),
  proposed_lane: z.object({
    title: z.string().trim().min(1),
    detail: z.string().trim().min(1),
  }),
});
export type SeedBrief = z.infer<typeof SeedBriefSchema>;

export const SeedSchema = z.object({
  id: z.string().min(1),
  team: z.string().min(1),
  relay_id: z.string().min(1),
  source: SeedSourceSchema,
  body: z.string(),
  captured_at: z.number().int().nonnegative(),
  slack_user_id: z.string().min(1),
  submitted_by: z.string().min(1),
  state: SeedStateSchema,
  explorer: z.string().min(1).nullable(),
  thread: z.array(SeedThreadEntrySchema),
  final_brief: SeedBriefSchema.nullable(),
  conclusion: z.string().nullable(),
  linked_lane_id: z.string().min(1).nullable(),
  promotion: z
    .object({
      kind: z.enum(['automatic', 'manual']),
      research_skipped: z.boolean(),
      at: z.number().int().nonnegative(),
    })
    .nullable(),
  completed_at: z.number().int().nonnegative().nullable(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
export type Seed = z.infer<typeof SeedSchema>;

/** ADR 314: one shared rule for the default Seed tray on every Surface. */
export const COMPLETED_SEED_TRAY_MS = 3 * 24 * 60 * 60 * 1_000;

export function seedInActiveTray(
  seed: Pick<Seed, 'state' | 'completed_at'>,
  now = Date.now(),
): boolean {
  if (
    seed.state === 'open' ||
    seed.state === 'exploring' ||
    seed.state === 'needs_clarification' ||
    seed.state === 'clarified'
  ) {
    return true;
  }
  return (
    seed.state === 'completed' &&
    seed.completed_at !== null &&
    seed.completed_at >= now - COMPLETED_SEED_TRAY_MS
  );
}

export const ClaimSeedSchema = z.object({});
export type ClaimSeed = z.infer<typeof ClaimSeedSchema>;

export const AskSeedClarificationSchema = z.object({ body: z.string().trim().min(1) });
export type AskSeedClarification = z.infer<typeof AskSeedClarificationSchema>;

export const AnswerSeedClarificationSchema = z.object({ body: z.string().trim().min(1) });
export type AnswerSeedClarification = z.infer<typeof AnswerSeedClarificationSchema>;

export const ConcludeSeedSchema = z.object({ conclusion: z.string().trim().min(1) });
export type ConcludeSeed = z.infer<typeof ConcludeSeedSchema>;

export const SubmitSeedBriefSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('promote'), brief: SeedBriefSchema }),
  z.object({
    result: z.literal('complete'),
    brief: SeedBriefSchema,
    conclusion: z.string().trim().min(1),
  }),
]);
export type SubmitSeedBrief = z.infer<typeof SubmitSeedBriefSchema>;

export const PromoteSeedSchema = z.object({
  title: z.string().trim().min(1).optional(),
  detail: z.string().trim().min(1).optional(),
});
export type PromoteSeed = z.infer<typeof PromoteSeedSchema>;

/** ADR 316: compact MCP discovery envelope; each action still parses its full protocol input. */
export const SeedMcpUpdateSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('claim'),
      id: SeedSchema.shape.id,
      input: ClaimSeedSchema.strict().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('ask'),
      id: SeedSchema.shape.id,
      input: AskSeedClarificationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('answer'),
      id: SeedSchema.shape.id,
      input: AnswerSeedClarificationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('submit'),
      id: SeedSchema.shape.id,
      input: SubmitSeedBriefSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('promote'),
      id: SeedSchema.shape.id,
      input: PromoteSeedSchema.optional(),
    })
    .strict(),
]);
export type SeedMcpUpdate = z.infer<typeof SeedMcpUpdateSchema>;

export const SeedResultSchema = z.object({ seed: SeedSchema });
export type SeedResult = z.infer<typeof SeedResultSchema>;

export const SeedListSchema = z.object({ seeds: z.array(SeedSchema) });
export type SeedList = z.infer<typeof SeedListSchema>;
