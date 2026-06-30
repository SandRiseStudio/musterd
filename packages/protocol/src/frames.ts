import { z } from 'zod';
import { PresenceStatusSchema, ProvenanceSchema, SurfaceSchema } from './acts.js';
import { ClaimFrame, OccupiedFrame, PendingFrame, RefusedFrame } from './claim-handshake.js';
import { EnvelopeSchema } from './envelope.js';
import { ErrorCodeSchema } from './errors.js';
import { MemberSchema } from './member.js';
import { PROTOCOL_VERSION } from './version.js';

export { ClaimFrame, OccupiedFrame, PendingFrame, RefusedFrame };
export type { ClaimTarget, RefusedCode } from './claim-handshake.js';

// ---- Client -> Server frames ----

export const HelloFrame = z.object({
  type: z.literal('hello'),
  v: z.literal(PROTOCOL_VERSION),
  team: z.string(),
  as: z.string(),
  token: z.string(),
  surface: SurfaceSchema,
  // Attach-time context (musterd/0.2, additive). Provenance = why this presence exists; workspace
  // = a gracefully-degrading "where" label (folder, qualified by branch/subpath). Both sticky for
  // the session: recorded once at join, read out of the roster — never re-declared per status.
  provenance: ProvenanceSchema.optional(),
  workspace: z.string().max(120).optional(),
  // Driver co-presence (musterd/0.2, additive; ADR 021). When a human is steering this agent's
  // session, the human's name — so the roster can say "driven by nick" instead of showing the
  // driving human as offline. Set by the adapter from `MUSTERD_DRIVER`; the adapter authenticates
  // only as the agent and never holds the human's token, so this names the driver without
  // impersonating them. Absent when no human is driving (e.g. a scheduled/daemon presence).
  driver: z.string().max(80).optional(),
});

export const SubscribeFrame = z.object({
  type: z.literal('subscribe'),
  // `team` (default) = recipient-routed delivery, unchanged. `team-all` = the firehose: every
  // envelope routed on the team, for read-only observers like the web dashboard (ADR 061).
  scope: z.enum(['team', 'team-all']).default('team'),
});

export const SendFrame = z.object({
  type: z.literal('send'),
  envelope: EnvelopeSchema,
});

export const HeartbeatFrame = z.object({
  type: z.literal('heartbeat'),
  status: PresenceStatusSchema.optional(),
});

export const WSClientFrame = z.discriminatedUnion('type', [
  HelloFrame,
  ClaimFrame,
  SubscribeFrame,
  SendFrame,
  HeartbeatFrame,
]);
export type WSClientFrame = z.infer<typeof WSClientFrame>;

// ---- Server -> Client frames ----

export const WelcomeFrame = z.object({
  type: z.literal('welcome'),
  member: MemberSchema,
  presence_id: z.string(),
  server_time: z.number().int(),
});

export const SubscribedFrame = z.object({
  type: z.literal('subscribed'),
  scope: z.enum(['team', 'team-all']),
});

export const AckFrame = z.object({
  type: z.literal('ack'),
  id: z.string(),
});

export const DeliverFrame = z.object({
  type: z.literal('deliver'),
  envelope: EnvelopeSchema,
});

export const PresenceEvtFrame = z.object({
  type: z.literal('presence'),
  member: z.string(),
  status: PresenceStatusSchema,
  surface: SurfaceSchema.optional(),
});

export const ErrorFrame = z.object({
  type: z.literal('error'),
  code: ErrorCodeSchema,
  message: z.string(),
});

export const WSServerFrame = z.discriminatedUnion('type', [
  WelcomeFrame,
  OccupiedFrame,
  RefusedFrame,
  PendingFrame,
  SubscribedFrame,
  AckFrame,
  DeliverFrame,
  PresenceEvtFrame,
  ErrorFrame,
]);
export type WSServerFrame = z.infer<typeof WSServerFrame>;
