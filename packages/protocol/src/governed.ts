import { z } from 'zod';

/**
 * Increment 3 governed model authorization (ADR 410). This is deliberately a separate contract from
 * seat-claim grants: a launch authorization proves one bounded workload handoff, not permission to
 * occupy a Team seat. Secrets are opaque and are returned once; consumers store only their hashes.
 */

export const GOVERNED_ENFORCEMENT_MODES = ['off', 'required'] as const;
export type GovernedEnforcementMode = (typeof GOVERNED_ENFORCEMENT_MODES)[number];
export const GovernedEnforcementModeSchema = z.enum(GOVERNED_ENFORCEMENT_MODES);

export const GOVERNED_LAUNCH_TTL_MIN_MS = 60_000;
export const GOVERNED_LAUNCH_TTL_DEFAULT_MS = 300_000;
export const GOVERNED_LAUNCH_TTL_MAX_MS = 900_000;

const ModelIdentifierSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/,
    'model must be an exact lowercase provider/model identifier',
  )
  .refine((model) => !/(?:^|\/)(?:latest|default)$/i.test(model), {
    message: 'floating model identifiers are not allowed',
  });

const NameSchema = z.string().min(1).max(120);
const IdSchema = z.string().min(1).max(128);
const CorrelationSchema = z.string().min(1).max(128);

const QuotaSchema = z
  .object({
    capacity: z.string().regex(/^\$[1-9]\d*(?:\.\d+)?$/, 'capacity must be positive dollars'),
    rate: z
      .string()
      .regex(/^\$[1-9]\d*(?:\.\d+)?\/[a-z]+$/, 'rate must be a positive dollar duration'),
  })
  .strict();

const GovernedPolicyMemberSchema = z
  .object({
    models: z.array(ModelIdentifierSchema).min(1),
    quota: QuotaSchema.optional(),
  })
  .strict();

function containsCredential(value: unknown): boolean {
  if (typeof value === 'string') return /^(?:mskey_|msgr_|mscr_|msac_|msls_|msla_)/i.test(value);
  if (Array.isArray(value)) return value.some(containsCredential);
  if (value !== null && typeof value === 'object')
    return Object.entries(value).some(
      ([key, child]) => containsCredential(key) || containsCredential(child),
    );
  return false;
}

/** Server-owned, secret-free effective policy. Member model sets may only narrow the Team set. */
export const GovernedPolicySchema = z
  .object({
    version: z.literal(1),
    enforcement: GovernedEnforcementModeSchema.default('off'),
    team: z
      .object({
        models: z.array(ModelIdentifierSchema).min(1),
        quota: QuotaSchema.optional(),
      })
      .strict(),
    members: z.record(NameSchema, GovernedPolicyMemberSchema).default({}),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (containsCredential(policy)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'governed policy must not contain a credential',
      });
    }
    const teamModels = new Set(policy.team.models);
    if (teamModels.size !== policy.team.models.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['team', 'models'],
        message: 'models must be unique',
      });
    }
    for (const [member, rule] of Object.entries(policy.members)) {
      if (rule.models.some((model) => !teamModels.has(model))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['members', member, 'models'],
          message: 'Member models must narrow the Team model ceiling',
        });
      }
    }
  });
export type GovernedPolicy = z.infer<typeof GovernedPolicySchema>;

export const GovernedWorkContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lane'), lane_id: IdSchema }).strict(),
  z.object({ kind: z.literal('act'), act_id: IdSchema }).strict(),
  z.object({ kind: z.literal('orientation'), allowance_id: IdSchema }).strict(),
]);
export type GovernedWorkContext = z.infer<typeof GovernedWorkContextSchema>;

/** Body for the future human/launcher issuance route. The issuer is always resolved from auth. */
export const GovernedLaunchAuthorizationIssueSchema = z
  .object({
    member: NameSchema,
    node_id: IdSchema,
    correlation: CorrelationSchema,
    context: GovernedWorkContextSchema,
    ttl_ms: z
      .number()
      .int()
      .min(GOVERNED_LAUNCH_TTL_MIN_MS)
      .max(GOVERNED_LAUNCH_TTL_MAX_MS)
      .default(GOVERNED_LAUNCH_TTL_DEFAULT_MS),
  })
  .strict();
export type GovernedLaunchAuthorizationIssue = z.infer<
  typeof GovernedLaunchAuthorizationIssueSchema
>;

/** Public projection of a launch authorization. It intentionally contains no credential. */
export const GovernedLaunchAuthorizationSchema = z
  .object({
    id: IdSchema,
    team: NameSchema,
    member: NameSchema,
    node_id: IdSchema,
    correlation: CorrelationSchema,
    context: GovernedWorkContextSchema,
    issued_by: NameSchema.nullable(),
    created_at: z.number().int(),
    expires_at: z.number().int(),
    consumed_at: z.number().int().nullable(),
    revoked_at: z.number().int().nullable(),
    presence_id: IdSchema.nullable(),
  })
  .strict();
export type GovernedLaunchAuthorization = z.infer<typeof GovernedLaunchAuthorizationSchema>;

/** Plaintext is returned once and must be held only by the launcher handoff. */
export const GovernedLaunchAuthorizationMintSchema = z
  .object({
    authorization: GovernedLaunchAuthorizationSchema,
    token: z.string().min(6).max(256).startsWith('msla_'),
  })
  .strict();
export type GovernedLaunchAuthorizationMint = z.infer<typeof GovernedLaunchAuthorizationMintSchema>;

/** Body used exactly once when the governed Presence attaches. */
export const GovernedLaunchAuthorizationConsumeSchema = z
  .object({
    token: z.string().min(6).max(256).startsWith('msla_'),
    launch_id: IdSchema,
    presence_id: IdSchema,
    member: NameSchema,
    node_id: IdSchema,
    correlation: CorrelationSchema,
  })
  .strict();
export type GovernedLaunchAuthorizationConsume = z.infer<
  typeof GovernedLaunchAuthorizationConsumeSchema
>;

/** Aperture's per-request authorization input. The node credential is the Bearer header. */
export const GovernedAuthorizationRequestSchema = z
  .object({
    launch_id: IdSchema,
    presence_id: IdSchema,
    correlation: CorrelationSchema,
    member: NameSchema,
    node_id: IdSchema,
    provider: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    model: ModelIdentifierSchema,
  })
  .strict();
export type GovernedAuthorizationRequest = z.infer<typeof GovernedAuthorizationRequestSchema>;

export const GOVERNED_REFUSAL_CODES = [
  'denied_node_unknown',
  'denied_node_revoked',
  'denied_member_unknown',
  'denied_member_inactive',
  'denied_node_binding',
  'denied_launch_unknown',
  'denied_launch_expired',
  'denied_launch_replayed',
  'denied_launch_revoked',
  'denied_launch_mismatch',
  'denied_presence_unknown',
  'denied_presence_stale',
  'denied_context_lane',
  'denied_context_act',
  'denied_context_orientation',
  'denied_model',
  'denied_policy',
] as const;
export type GovernedRefusalCode = (typeof GOVERNED_REFUSAL_CODES)[number];
export const GovernedRefusalCodeSchema = z.enum(GOVERNED_REFUSAL_CODES);

export const GovernedDecisionSchema = z
  .object({
    decision: z.enum(['allow', 'deny']),
    reason: z.union([z.literal('allowed'), GovernedRefusalCodeSchema]),
    launch_id: IdSchema,
    correlation: CorrelationSchema,
    member: NameSchema.optional(),
    node_id: IdSchema.optional(),
    provider: z.string().optional(),
    model: ModelIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.decision === 'allow' && decision.reason !== 'allowed')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'allow requires allowed reason',
      });
    if (decision.decision === 'deny' && decision.reason === 'allowed')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'deny requires refusal reason',
      });
  });
export type GovernedDecision = z.infer<typeof GovernedDecisionSchema>;

export const GovernedPolicyResponseSchema = z
  .object({ policy: GovernedPolicySchema, updated_at: z.number().int() })
  .strict();
export type GovernedPolicyResponse = z.infer<typeof GovernedPolicyResponseSchema>;

export const GovernedPolicyReadResponseSchema = z
  .object({ policy: GovernedPolicySchema.nullable(), updated_at: z.number().int().nullable() })
  .strict();
export type GovernedPolicyReadResponse = z.infer<typeof GovernedPolicyReadResponseSchema>;
