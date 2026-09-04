import { z } from 'zod';
import { SEED_STATES } from './seeds.wire.js';

/** The Seed vocabulary itself is validator-free (`seeds.wire.js`); this module is its zod face. */
export {
  COMPLETED_SEED_TRAY_MS,
  SEED_STATES,
  seedInActiveTray,
  type SeedState,
} from './seeds.wire.js';

export const SeedStateSchema = z.enum(SEED_STATES);

/**
 * Where a Seed was captured. `slack` arrives through the relay (ADR 248/311); `repo` is a
 * document-recorded intention — a `Follows-up:` marker or an undisposed forward reference in this
 * repo's own documents — captured by `pnpm intents:ingest` (ADR 373 increment 2). The relay boundary
 * below stays Slack-only: widening THIS enum is the whole schema delta ADR 373 authorizes.
 */
export const SeedSourceSchema = z.enum(['slack', 'repo']);
export type SeedSource = z.infer<typeof SeedSourceSchema>;

/** ADR 311: the relay accepts Slack captures only. Unchanged by ADR 373. */
export const RelaySeedSourceSchema = z.literal('slack');

/** Raw relay boundary accepted by shared-Seed ingest (ADR 311). */
export const RelaySeedSchema = z.object({
  id: z.string().min(1),
  body: z
    .string()
    .refine((body) => body.trim().length > 0, 'body must contain non-whitespace text'),
  ts: z.number().int().nonnegative(),
  source: RelaySeedSourceSchema,
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
  /** The Slack author for a relay capture; null for a `repo` Seed, whose author is a document. */
  slack_user_id: z.string().min(1).nullable(),
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

// The tray rule and `COMPLETED_SEED_TRAY_MS` live in `seeds.wire.js`; re-exported above.

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

/** ADR 318: compact MCP discovery envelope; each action still parses its full protocol input. */
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

/**
 * ADR 373 increment 2: capture a document-recorded intention as a Seed. `ref` is the source's own
 * identifier — repo path plus an anchor (`docs/decisions/354-….md#left-for-a-sibling-lane`) — and
 * plays the role `relay_id` plays for Slack, so a re-run captures nothing twice. `lane_id` is the
 * lane a `Follows-up: <lane-id>` already names: the Seed is born promoted with `linked_lane_id` set,
 * which is the provenance edge (seed → lane) ADR 248 built and ADR 373 reuses instead of a new field.
 */
export const CaptureRepoSeedSchema = z.object({
  ref: z.string().trim().min(1).max(500),
  body: z.string().refine((b) => b.trim().length > 0, 'body must contain non-whitespace text'),
  captured_at: z.number().int().nonnegative().optional(),
  lane_id: z.string().min(1).optional(),
});
export type CaptureRepoSeed = z.infer<typeof CaptureRepoSeedSchema>;

export const SeedResultSchema = z.object({ seed: SeedSchema });
export type SeedResult = z.infer<typeof SeedResultSchema>;

export const SeedListSchema = z.object({ seeds: z.array(SeedSchema) });
export type SeedList = z.infer<typeof SeedListSchema>;
