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
  /** The requesting session's WS connId (the claim's `from_session`). */
  from_session: z.string(),
  /** The encoded claim target — `seat:<name>` | `role:<name>` | `observe`; null for a teammate join. */
  target: z.string().nullable(),
  /** The client surface the claim came from (`claude-code`/`cursor`/`web`/`cli`) — admin-card badge. */
  surface: z.string(),
  status: RequestStatusSchema,
  /** Admin seat that decided it; null while pending/expired. */
  decided_by: z.string().nullable(),
  /** Created-at, ms epoch. */
  ts: z.number().int(),
  /** Absolute expiry (ms epoch) = created_at + the 1h default (ADR 069 decision 2); drives the
   *  approval-card countdown + the reaper. */
  expires_at: z.number().int(),
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

/** Response body of `GET /teams/:slug/requests` — requests, newest-first. */
export const RequestsResponseSchema = z.object({
  requests: z.array(RequestSchema),
});
export type RequestsResponse = z.infer<typeof RequestsResponseSchema>;

/** Response body of `POST /teams/:slug/requests/:id/decide` (ADR 077). `delivered` is true when the
 *  terminal frame reached a live waiting session (e.g. a WS `claim` hold) — false means the requester's
 *  session already disconnected and must re-claim to pick up the decision. */
export const DecideResponseSchema = z.object({
  request_id: z.string(),
  decision: z.enum(['approve', 'deny']),
  delivered: z.boolean(),
});
export type DecideResponse = z.infer<typeof DecideResponseSchema>;
