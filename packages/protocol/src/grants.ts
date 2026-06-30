import { z } from 'zod';

/**
 * Grants (SPEC A.2, ADR 069 P3 / ADR 076) — admin-issued authorization for a session to claim a seat or
 * role. The **public** shape served to admins; the grant's secret token (`msgr_…`, see
 * {@link ./credentials}) is daemon-private (stored as a sha256 hash) and never appears here.
 */

/** What a grant authorizes claiming: a specific seat, or any seat of a role. */
export const GrantScopeSchema = z.enum(['seat', 'role']);
export type GrantScope = z.infer<typeof GrantScopeSchema>;

/** How long a grant lives: `once` (single use), `ttl` (until `expires_at`), `standing` (until revoked). */
export const GrantLifetimeSchema = z.enum(['once', 'ttl', 'standing']);
export type GrantLifetime = z.infer<typeof GrantLifetimeSchema>;

export const GrantSchema = z.object({
  id: z.string(),
  team: z.string(),
  scope: GrantScopeSchema,
  /** The seat or role name this grant authorizes claiming. */
  target: z.string(),
  /** Admin seat that issued it; null for system-issued. */
  issued_by: z.string().nullable(),
  lifetime: GrantLifetimeSchema,
  /** Set for `ttl` grants (ms epoch); null for `once`/`standing`. */
  expires_at: z.number().int().nullable(),
  /** The `once` consumption flag — true means it is spent on first successful claim. */
  single_use: z.boolean(),
  revoked: z.boolean(),
  created_at: z.number().int(),
});
export type Grant = z.infer<typeof GrantSchema>;

/** Admin body to issue a grant (`POST /teams/:slug/grants`). `ttl_hours` is required iff `lifetime=ttl`. */
export const IssueGrantSchema = z
  .object({
    scope: GrantScopeSchema,
    target: z.string().min(1),
    lifetime: GrantLifetimeSchema,
    ttl_hours: z.number().positive().optional(),
    single_use: z.boolean().optional(),
  })
  .refine((g) => g.lifetime !== 'ttl' || g.ttl_hours != null, {
    message: 'ttl lifetime requires ttl_hours',
    path: ['ttl_hours'],
  });
export type IssueGrant = z.infer<typeof IssueGrantSchema>;

/** Mint response — the grant plus its plaintext token, shown **exactly once** (never re-fetchable). */
export const GrantMintSchema = z.object({ grant: GrantSchema, token: z.string() });
export type GrantMint = z.infer<typeof GrantMintSchema>;
