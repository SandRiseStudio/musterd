import { z } from 'zod';
import { PresenceStatusSchema, ProvenanceSchema, SurfaceSchema } from './acts.js';
import { EnvelopeSchema } from './envelope.js';
import { ErrorCodeSchema } from './errors.js';
import { MemberSchema } from './member.js';
import { PROTOCOL_VERSION } from './version.js';

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
});

export const SubscribeFrame = z.object({
  type: z.literal('subscribe'),
  scope: z.enum(['team']).default('team'),
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
  scope: z.enum(['team']),
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
  SubscribedFrame,
  AckFrame,
  DeliverFrame,
  PresenceEvtFrame,
  ErrorFrame,
]);
export type WSServerFrame = z.infer<typeof WSServerFrame>;
