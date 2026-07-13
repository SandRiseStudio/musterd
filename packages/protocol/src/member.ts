import { z } from 'zod';
import {
  ActivitySchema,
  LifecycleSchema,
  MemberKindSchema,
  PresenceStatusSchema,
  ProvenanceSchema,
  SurfaceSchema,
} from './acts.js';
import { AccountStatusSchema, CapabilitiesSchema } from './capabilities.js';

/**
 * The self-set availability axis (SPEC A.6 Axis 2) — explicit, **never inferred**. `away_until(ts)`
 * is encoded as `{ status: 'away', until: <ms epoch> }`. The localhost down-payment (ADR 044) stores
 * and exposes this; `off_hours` / full schedule enforcement is roadmap.
 */
export const AvailabilityStatusSchema = z.enum(['available', 'away', 'dnd']);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatusSchema>;

export const AvailabilitySchema = z.object({
  status: AvailabilityStatusSchema,
  /** For `away_until`: when the member expects to be back (ms epoch). Only meaningful with `away`. */
  until: z.number().int().positive().nullish(),
});
export type Availability = z.infer<typeof AvailabilitySchema>;

/** A durable identity in a Team. Never a session. Mirrors the `members` table (minus token_hash). */
export const MemberSchema = z.object({
  id: z.string(),
  team: z.string(),
  name: z.string(),
  kind: MemberKindSchema,
  role: z.string().default(''),
  lifecycle: LifecycleSchema.default('forever'),
  lifecycle_until: z.number().int().nullish(),
  availability: AvailabilitySchema.nullish(),
  /** Account status — Axis 1 (ADR 070). Optional for back-compat; the server always resolves it. */
  account_status: AccountStatusSchema.optional(),
  /** Effective capabilities (ADR 070). Optional for back-compat; the server always resolves it. */
  capabilities: CapabilitiesSchema.optional(),
  created_at: z.number().int(),
});
export type Member = z.infer<typeof MemberSchema>;

/** One active attachment of a Member to a Surface. */
export const PresenceSchema = z.object({
  surface: SurfaceSchema,
  status: PresenceStatusSchema,
  last_seen_at: z.number().int(),
  /** Why this attachment exists (musterd/0.2). Recorded at attach; null on pre-0.2 rows. */
  provenance: ProvenanceSchema.nullish(),
  /** The "where" label captured at attach (folder, qualified by branch/subpath). */
  workspace: z.string().nullish(),
  /** Driver co-presence (musterd/0.2; ADR 021): the human steering this agent's session, when one
   * is. Lets the roster name the co-present human instead of showing them offline; null otherwise. */
  driver: z.string().nullish(),
  /** Harness-attested model id for this occupancy (ADR 101). Attested, never verified; null/absent
   *  when the adapter doesn't attest — rendered as `unknown`, never blocks. */
  model: z.string().nullish(),
});
export type Presence = z.infer<typeof PresenceSchema>;

/** A Member plus a summary of where (if anywhere) they are currently present — used by roster/status. */
export const MemberSummarySchema = MemberSchema.extend({
  presence: PresenceStatusSchema,
  presences: z.array(PresenceSchema).default([]),
  /** Coarse roster activity (musterd/0.2). Optional for back-compat; the server always sets it. */
  activity: ActivitySchema.optional(),
  /** Self-reported task summary backing `working`, from the latest `status_update`. */
  state: z.string().nullish(),
  /** When `state` was last refreshed (ms epoch); drives staleness in the roster. */
  last_status_at: z.number().int().nullish(),
  /**
   * True when the seat is *held within its reclaim-grace window* (ADR 010) — a **reservation**, not
   * live presence. The seat still reads `presence: 'offline'` (grace is hidden from display, ADR 010),
   * but it may be reconnecting, so the clobber guard (ADR 066/105) treats it as occupied. Optional for
   * back-compat; the server always sets it.
   */
  reclaimable: z.boolean().optional(),
  /**
   * True when the seat is enrolled in harness residency (ADR 131) — offline is not unreachable: a
   * directed act can wake it, so the roster reads `offline · wakeable`. An enrollment fact (set
   * whether or not the seat is currently offline); renderers apply it to the offline label.
   * Optional for back-compat; the server always sets it.
   */
  wakeable: z.boolean().optional(),
});
export type MemberSummary = z.infer<typeof MemberSummarySchema>;
