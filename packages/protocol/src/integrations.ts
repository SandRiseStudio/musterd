import { z } from 'zod';

/** Vendor-owned Tailscale status JSON. The inspector reads only Self's identity and reachability facts. */
export const TailscaleStatusSchema = z
  .object({
    Self: z
      .object({
        DNSName: z.string(),
        TailscaleIPs: z.array(z.string()),
        Online: z.boolean(),
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
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tailscale section must be tagged tailscale', path: ['tailscale', 'integration'] });
    }
    if (report.aperture.integration !== 'aperture') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'aperture section must be tagged aperture', path: ['aperture', 'integration'] });
    }
    const hasSelectedFailure = [report.tailscale, report.aperture].some(
      (section) => section.selected && section.checks.some((check) => check.state === 'fail'),
    );
    if (report.ok === hasSelectedFailure) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ok must equal the absence of selected failures', path: ['ok'] });
    }
  });
export type IntegrationDoctorReport = z.infer<typeof IntegrationDoctorReportSchema>;
