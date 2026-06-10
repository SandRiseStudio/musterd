import { z } from 'zod';
import {
  LifecycleSchema,
  MemberKindSchema,
  PresenceStatusSchema,
  SurfaceSchema,
} from './acts.js';

/** A durable identity in a Team. Never a session. Mirrors the `members` table (minus token_hash). */
export const MemberSchema = z.object({
  id: z.string(),
  team: z.string(),
  name: z.string(),
  kind: MemberKindSchema,
  role: z.string().default(''),
  lifecycle: LifecycleSchema.default('forever'),
  lifecycle_until: z.number().int().nullish(),
  availability: z.record(z.unknown()).nullish(),
  created_at: z.number().int(),
});
export type Member = z.infer<typeof MemberSchema>;

/** One active attachment of a Member to a Surface. */
export const PresenceSchema = z.object({
  surface: SurfaceSchema,
  status: PresenceStatusSchema,
  last_seen_at: z.number().int(),
});
export type Presence = z.infer<typeof PresenceSchema>;

/** A Member plus a summary of where (if anywhere) they are currently present — used by roster/status. */
export const MemberSummarySchema = MemberSchema.extend({
  presence: PresenceStatusSchema,
  presences: z.array(PresenceSchema).default([]),
});
export type MemberSummary = z.infer<typeof MemberSummarySchema>;
