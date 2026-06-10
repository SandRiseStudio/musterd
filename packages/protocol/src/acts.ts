import { z } from 'zod';

/** The seven collaboration acts (Co-Gym-grounded). Order is stable. */
export const ACTS = [
  'message',
  'status_update',
  'request_help',
  'handoff',
  'accept',
  'decline',
  'wait',
] as const;
export type Act = (typeof ACTS)[number];
export const ActSchema = z.enum(ACTS);

/** Surfaces a Member can be present on. v0.1 implements cli/claude-code/codex; the rest are reserved. */
export const SURFACES = ['cli', 'claude-code', 'codex', 'cursor', 'web', 'ios', 'slack', 'other'] as const;
export type Surface = (typeof SURFACES)[number];
export const SurfaceSchema = z.enum(SURFACES);

/** Member lifecycle. `until` requires a timestamp. */
export const LIFECYCLES = ['forever', 'session', 'until'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export const LifecycleSchema = z.enum(LIFECYCLES);

/** Member kind. Humans are first-class members, not approvers. */
export const MEMBER_KINDS = ['agent', 'human'] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];
export const MemberKindSchema = z.enum(MEMBER_KINDS);

/** Presence status. `away` is only ever set explicitly by a client. */
export const PRESENCE_STATUSES = ['online', 'away', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];
export const PresenceStatusSchema = z.enum(PRESENCE_STATUSES);
