import { z } from 'zod';

const ExactModelSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/,
    'model must be an exact lowercase provider/model identifier',
  )
  .refine((model) => !/(?:^|\/)(?:latest|default)$/i.test(model), {
    message: 'floating model identifiers are not allowed',
  });

const DollarQuotaSchema = z.object({
  capacity: z.string().regex(/^\$[1-9]\d*(?:\.\d+)?$/, 'capacity must be positive dollars'),
  rate: z
    .string()
    .regex(/^\$[1-9]\d*(?:\.\d+)?\/[a-z]+$/, 'rate must be a positive dollar duration'),
});

const WorkloadIdSchema = z
  .string()
  .regex(/^[a-z0-9]{6,64}$/, 'workload_id must be lowercase opaque alphanumeric text');

/**
 * Secret-free, provider-neutral policy input for the governed-model generator (ADR 400).
 * Provider syntax begins at the renderer boundary; these fields describe only Team intent.
 */
export const GovernedModelsManifestSchema = z
  .object({
    version: z.literal(1),
    team: z.object({
      models: z.array(ExactModelSchema).min(1),
      quota: DollarQuotaSchema,
      default_tier: z.string().min(1),
    }),
    quota_tiers: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
          quota: DollarQuotaSchema,
        }),
      )
      .min(1),
    roles: z
      .record(
        z.object({
          models: z.array(ExactModelSchema).min(1).optional(),
          quota_tier: z.string().min(1).optional(),
        }),
      )
      .default({}),
    workloads: z.record(z.object({ workload_id: WorkloadIdSchema })).default({}),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const modelSet = new Set(manifest.team.models);
    if (modelSet.size !== manifest.team.models.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['team', 'models'],
        message: 'models must be unique',
      });
    }
    const tierIds = new Set<string>();
    let previous: { capacity: number; rate: number } | undefined;
    for (const [index, tier] of manifest.quota_tiers.entries()) {
      if (tierIds.has(tier.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quota_tiers', index, 'id'],
          message: 'quota tier ids must be unique',
        });
      }
      tierIds.add(tier.id);
      const capacity = Number(tier.quota.capacity.slice(1));
      const rate = Number(tier.quota.rate.slice(1).split('/')[0]);
      if (previous && (capacity >= previous.capacity || rate >= previous.rate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quota_tiers', index],
          message: 'quota tiers must become strictly more restrictive',
        });
      }
      previous = { capacity, rate };
    }
    if (!tierIds.has(manifest.team.default_tier)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['team', 'default_tier'],
        message: 'default_tier must name a quota tier',
      });
    }
    const workloadIds = new Set<string>();
    for (const [member, mapping] of Object.entries(manifest.workloads)) {
      if (workloadIds.has(mapping.workload_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workloads', member],
          message: 'workload_id must be unique',
        });
      }
      workloadIds.add(mapping.workload_id);
    }
  });
export type GovernedModelsManifest = z.infer<typeof GovernedModelsManifestSchema>;

/** Vendor-owned Tailscale status JSON. The inspector reads only Self's identity and reachability facts. */
export const TailscaleStatusSchema = z
  .object({
    BackendState: z.string().optional(),
    Self: z
      .object({
        DNSName: z.string(),
        TailscaleIPs: z.array(z.string()).optional(),
        Online: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type TailscaleStatus = z.infer<typeof TailscaleStatusSchema>;

/** Vendor-owned Tailscale Serve status JSON. */
export const TailscaleServeStatusSchema = z
  .object({
    TCP: z.record(z.object({ TCPForward: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();
export type TailscaleServeStatus = z.infer<typeof TailscaleServeStatusSchema>;

const ApertureCapabilitySchema = z
  .object({
    role: z.string().optional(),
    models: z.union([z.string(), z.array(z.string())]).optional(),
    quotas: z.array(z.object({ bucket: z.string() }).passthrough()).optional(),
  })
  .passthrough();

const ApertureGrantSchema = z
  .object({
    src: z.array(z.string()),
    app: z
      .object({ 'tailscale.com/cap/aperture': z.array(ApertureCapabilitySchema).optional() })
      .passthrough(),
  })
  .passthrough();

const ApertureProviderSchema = z
  .object({
    baseurl: z.string(),
    models: z.array(z.string()),
  })
  .passthrough();

const ApertureQuotaSchema = z
  .object({
    capacity: z.string(),
    rate: z.string(),
    on_exceed: z.string(),
  })
  .passthrough();

/** Parsed Aperture HuJSON configuration. Vendor-owned levels deliberately retain unknown future keys. */
export const ApertureConfigSchema = z
  .object({
    providers: z.record(ApertureProviderSchema).optional(),
    grants: z.array(ApertureGrantSchema).optional(),
    quotas: z.record(ApertureQuotaSchema).optional(),
    database: z
      .object({
        retention: z
          .object({
            duration: z.string().optional(),
            purge: z.array(z.string()).optional(),
            require_export: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ApertureConfig = z.infer<typeof ApertureConfigSchema>;

/** The GET /api/config wrapper; its config string is parsed separately as HuJSON. */
export const ApertureConfigResponseSchema = z
  .object({
    config: z.string(),
    hash: z.string(),
  })
  .passthrough();

export const IntegrationCheckSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    state: z.enum(['ok', 'fail', 'skip']),
    detail: z.string().min(1).optional(),
    fix: z.string().min(1).optional(),
  })
  .strict();
export type IntegrationCheck = z.infer<typeof IntegrationCheckSchema>;

export const IntegrationSectionSchema = z
  .object({
    integration: z.enum(['tailscale', 'aperture']),
    selected: z.boolean(),
    posture: z.enum(['off', 'verified', 'ready', 'blocked']),
    checks: z.array(IntegrationCheckSchema),
  })
  .strict();
export type IntegrationSection = z.infer<typeof IntegrationSectionSchema>;

export const IntegrationDoctorReportSchema = z
  .object({
    version: z.literal(1),
    ok: z.boolean(),
    observed_at: z.number().int().nonnegative(),
    tailscale: IntegrationSectionSchema,
    aperture: IntegrationSectionSchema,
    limits: z.array(z.string().min(1)).length(2),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (report.tailscale.integration !== 'tailscale') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tailscale section must be tagged tailscale',
        path: ['tailscale', 'integration'],
      });
    }
    if (report.aperture.integration !== 'aperture') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'aperture section must be tagged aperture',
        path: ['aperture', 'integration'],
      });
    }
    const hasSelectedFailure = [report.tailscale, report.aperture].some(
      (section) => section.selected && section.checks.some((check) => check.state === 'fail'),
    );
    if (report.ok === hasSelectedFailure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ok must equal the absence of selected failures',
        path: ['ok'],
      });
    }
  });
export type IntegrationDoctorReport = z.infer<typeof IntegrationDoctorReportSchema>;
