import { z } from 'zod';
import {
  ACTIVITIES_ON_WIRE,
  ACTS,
  LIFECYCLES,
  MEMBER_KINDS,
  PRESENCE_STATUSES,
  PROVENANCES,
  SURFACES,
  normalizeActivity,
} from './acts.wire.js';

/**
 * The zod face of the act/surface/presence vocabularies. Every closed set lives in
 * `acts.wire.js` — plain tuples, no validator — and this module builds the enums from them and
 * re-exports the names, so `@musterd/protocol` keeps its one-import surface while a browser can
 * read the vocabulary without pulling zod into its bundle (ADR 148 read path; `guards.ts`).
 */
export {
  ACTIVITIES,
  ACTIVITIES_ON_WIRE,
  ACTS,
  LIFECYCLES,
  MEMBER_KINDS,
  PRESENCE_STATUSES,
  PROVENANCES,
  SURFACES,
  normalizeActivity,
} from './acts.wire.js';
export type {
  Activity,
  Act,
  Lifecycle,
  MemberKind,
  PresenceStatus,
  Provenance,
  Surface,
} from './acts.wire.js';

export const ActSchema = z.enum(ACTS);
export const SurfaceSchema = z.enum(SURFACES);
export const LifecycleSchema = z.enum(LIFECYCLES);
export const MemberKindSchema = z.enum(MEMBER_KINDS);
export const PresenceStatusSchema = z.enum(PRESENCE_STATUSES);
export const ActivitySchema = z.enum(ACTIVITIES_ON_WIRE).transform(normalizeActivity);
export const ProvenanceSchema = z.enum(PROVENANCES);
