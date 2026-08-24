import { z } from 'zod';
import type { Activity } from './acts.js';

/**
 * Roster posture (ADR 138) — the composed “what kind of present/absent?” read for chips and roll
 * calls. Derived server-side from `activity` ∩ `availability` (availability outranks, ADR 044); clients
 * render the wire token, they do not invent synonyms.
 *
 * `active` is the live-but-no-fresh-claim state (activity `active`; renamed from `idle` per the
 * presence-honesty spec §2.1 — "idle" always described absence of a claim, not rest); `away` folds
 * explicit `away`/`dnd` availability. Offline *reasons* ride `offline_reason` (ADR 141). Legacy
 * `idle` from an old daemon is accepted on read and normalized to `active`.
 */
export const POSTURES = ['working', 'active', 'away', 'offline'] as const;
export type Posture = (typeof POSTURES)[number];
export const PostureSchema = z
  .enum([...POSTURES, 'idle'])
  .transform((p): Posture => (p === 'idle' ? 'active' : p));

export interface PostureInput {
  activity: Activity;
  /** Explicit availability (Axis 2). Absent/`available` never overrides activity. */
  availability?: { status: 'available' | 'away' | 'dnd' | 'off_hours' } | null;
}

/**
 * Resolve roster posture. Order matches the CLI status grouping (ADR 044):
 * offline → away/dnd/off_hours → working → active.
 */
export function resolvePosture(input: PostureInput): Posture {
  if (input.activity === 'offline') return 'offline';
  const avail = input.availability?.status;
  if (avail === 'away' || avail === 'dnd' || avail === 'off_hours') return 'away';
  if (input.activity === 'working') return 'working';
  return 'active';
}
