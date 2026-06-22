import { z } from 'zod';

/**
 * The eight collaboration acts (Co-Gym-grounded). Order is stable; new acts append.
 * `resolve` (musterd/0.3, ADR 025) is the terminal act — it closes a thread (the proto-work-item),
 * supplying the open-vs-done axis the prior seven lacked (`accept` ≠ finished).
 */
export const ACTS = [
  'message',
  'status_update',
  'request_help',
  'handoff',
  'accept',
  'decline',
  'wait',
  'resolve',
] as const;
export type Act = (typeof ACTS)[number];
export const ActSchema = z.enum(ACTS);

/** Surfaces a Member can be present on. v0.1 implements cli/claude-code/codex; the rest are reserved. */
export const SURFACES = [
  'cli',
  'claude-code',
  'codex',
  'cursor',
  'web',
  'ios',
  'slack',
  'other',
] as const;
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

/**
 * Roster activity (musterd/0.2). A coarser, demo-facing read of a member than raw presence:
 * `offline` (no live attachment), `online` (present, idle), `working` (present + a self-reported
 * task). Resolved server-side from presence + the latest `status_update` (two-clocks rule).
 */
export const ACTIVITIES = ['offline', 'online', 'working'] as const;
export type Activity = (typeof ACTIVITIES)[number];
export const ActivitySchema = z.enum(ACTIVITIES);

/**
 * Provenance (musterd/0.2): *why* a presence exists, captured as a fact at attach time — never
 * guessed (human-agent-dynamics §2). `session` = a human opened a harness session; `asked` = a
 * member was asked to do something; `hook` = a harness hook/function fired; `scheduled` = a timer
 * started it; `daemon` = an always-on process. It dissolves the driving-posture confusion without
 * modelling humans: `(session)` says "someone is behind this", `(scheduled)` says "nobody need be".
 */
export const PROVENANCES = ['session', 'asked', 'hook', 'scheduled', 'daemon'] as const;
export type Provenance = (typeof PROVENANCES)[number];
export const ProvenanceSchema = z.enum(PROVENANCES);
