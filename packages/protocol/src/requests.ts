import { z } from 'zod';
import { GrantLifetimeSchema } from './grants.js';

/**
 * The request/approval lane (SPEC A.5, ADR 069 P3 / ADR 076) — a session asks to claim a seat or join as
 * a teammate and waits for an admin to decide. The store + types are P3.1 (this); the WS push + decide
 * endpoint are P3.2 (ADR 077). Requests are **deduped by `(team, from_session, target)`** (ADR 069
 * decision 3), so a re-issued claim returns the existing open request rather than stacking duplicates.
 */

export const RequestKindSchema = z.enum(['claim', 'teammate']);
export type RequestKind = z.infer<typeof RequestKindSchema>;

export const RequestStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

export const RequestSchema = z.object({
  id: z.string(),
  team: z.string(),
  kind: RequestKindSchema,
  /** Opaque id of the requesting session (the claim's `from_session`). */
  from_session: z.string(),
  /** Seat/role being claimed; null for a bare teammate-join request. */
  target: z.string().nullable(),
  status: RequestStatusSchema,
  /** Admin seat that decided it; null while pending/expired. */
  decided_by: z.string().nullable(),
  /** Created-at, ms epoch (drives the 1h-default expiry, ADR 069 decision 2). */
  ts: z.number().int(),
});
export type Request = z.infer<typeof RequestSchema>;

/**
 * Admin decide body (`POST /teams/:slug/requests/:id/decide`, ADR 069 decision 4) — an approve **binds a
 * grant lifetime** (the approved session gets a grant of this lifetime). Consumed by the request lane
 * (ADR 077); the lifetime types are owned here in P3.1 so both sides share one contract.
 */
export const DecideRequestSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('approve'),
    lifetime: GrantLifetimeSchema,
    ttl_hours: z.number().positive().optional(),
  }),
  z.object({ decision: z.literal('deny') }),
]);
export type DecideRequest = z.infer<typeof DecideRequestSchema>;
